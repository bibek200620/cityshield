from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.heat import city_study
from app.heat.city_study import (
    CACHE_SCHEMA_VERSION,
    FEATURES,
    LandsatSceneError,
    FEATURE_SCHEMA,
    PREPROCESSING_VERSION,
    QA_BAD_BITS_SET,
    TARGET_UNITS,
    load_cached_samples,
    scene_manifest_path,
    spatial_holdout_indices,
    validate_scene_compatibility,
    validate_scene_item,
)


def _scene(scene_id: str, *, sensor: str = "landsat-8", x_origin: float = 630285.0) -> dict:
    parts = scene_id.split("_")
    date = f"{parts[3][:4]}-{parts[3][4:6]}-{parts[3][6:]}"
    return {
        "scene_id": scene_id,
        "stac_item_id": "_".join((*parts[:4], *parts[5:])),
        "date": date,
        "datetime": f"{date}T05:10:00+00:00",
        "collection": "landsat-c2-l2",
        "sensor": sensor,
        "crs": "EPSG:32643",
        "source_transform": [30.0, 0.0, x_origin, 0.0, -30.0, 1554915.0],
        "window_transform": [30.0, 0.0, 766935.0, 0.0, -30.0, 1454355.0],
        "pixel_resolution_m": 30.0,
        "cloud_cover_percent": 2.0,
        "feature_names": list(FEATURES),
        "feature_units": {name: "unitless" for name in FEATURES},
        "target_units": "degrees Celsius",
        "preprocessing_version": "landsat-c2-l2-features-v2",
        "qa_bad_bits": [0, 1, 2, 3, 4, 5],
    }


def test_scene_compatibility_accepts_landsat_8_and_9_on_aligned_grid():
    scenes = [
        _scene("LC08_L2SP_144051_20250414_20250424_02_T1"),
        _scene("LC09_L2SP_144051_20250508_20250513_02_T1", sensor="landsat-9", x_origin=630315.0),
    ]

    validate_scene_compatibility(scenes)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("crs", "EPSG:4326"),
        ("pixel_resolution_m", 60.0),
        ("feature_names", list(reversed(FEATURES))),
        ("target_units", "kelvin"),
    ],
)
def test_scene_compatibility_rejects_incompatible_metadata(field: str, value):
    first = _scene("LC08_L2SP_144051_20250414_20250424_02_T1")
    second = _scene("LC09_L2SP_144051_20250508_20250513_02_T1", sensor="landsat-9")
    second[field] = value

    with pytest.raises(LandsatSceneError):
        validate_scene_compatibility([first, second])


def test_scene_compatibility_rejects_transform_off_common_pixel_lattice():
    first = _scene("LC08_L2SP_144051_20250414_20250424_02_T1")
    second = _scene(
        "LC09_L2SP_144051_20250508_20250513_02_T1",
        sensor="landsat-9",
        x_origin=630300.0,
    )

    with pytest.raises(LandsatSceneError, match="pixel lattice"):
        validate_scene_compatibility([first, second])


def test_scene_compatibility_rejects_different_aoi_window_transform():
    first = _scene("LC08_L2SP_144051_20250414_20250424_02_T1")
    second = _scene("LC09_L2SP_144051_20250508_20250513_02_T1", sensor="landsat-9", x_origin=630315.0)
    second["window_transform"][2] += 30.0

    with pytest.raises(LandsatSceneError, match="common grid"):
        validate_scene_compatibility([first, second])


def test_scene_compatibility_rejects_sensor_and_date_mismatch():
    scene = _scene("LC08_L2SP_144051_20250414_20250424_02_T1")
    scene["sensor"] = "landsat-9"

    with pytest.raises(LandsatSceneError, match="metadata disagree"):
        validate_scene_compatibility([scene])


def test_scene_item_records_sensor_collection_and_acquisition_metadata():
    item = {
        "id": "LC09_L2SP_144051_20250508_02_T1",
        "collection": "landsat-c2-l2",
        "properties": {"platform": "landsat-9", "datetime": "2025-05-08T05:10:00Z", "eo:cloud_cover": 2.0},
        "assets": {name: {"href": f"https://example.test/{name}"} for name in (
            "blue", "green", "red", "nir08", "swir16", "swir22", "lwir11", "emis", "qa_pixel",
        )},
    }

    assert validate_scene_item(item) == {
        "stac_item_id": "LC09_L2SP_144051_20250508_02_T1",
        "collection": "landsat-c2-l2",
        "sensor": "landsat-9",
        "date": "2025-05-08",
        "datetime": "2025-05-08T05:10:00+00:00",
        "cloud_cover_percent": 2.0,
    }


def test_scene_item_rejects_mismatched_sensor_or_missing_band():
    item = {
        "id": "LC09_L2SP_144051_20250508_02_T1",
        "collection": "landsat-c2-l2",
        "properties": {"platform": "landsat-8", "datetime": "2025-05-08T05:10:00Z", "eo:cloud_cover": 2.0},
        "assets": {name: {} for name in ("blue", "green", "red", "nir08", "swir16", "swir22", "lwir11", "emis", "qa_pixel")},
    }
    with pytest.raises(LandsatSceneError, match="disagree"):
        validate_scene_item(item)
    item["properties"]["platform"] = "landsat-9"
    del item["assets"]["qa_pixel"]
    with pytest.raises(LandsatSceneError, match="missing required"):
        validate_scene_item(item)


def test_pick_scene_uses_cached_stac_manifest_before_network(tmp_path, monkeypatch):
    item = {
        "id": "LC08_L2SP_144051_20250414_02_T1",
        "collection": "landsat-c2-l2",
        "properties": {
            "platform": "landsat-8",
            "datetime": "2025-04-14T05:10:00Z",
            "eo:cloud_cover": 2.0,
        },
        "assets": {name: {"href": f"https://example.test/{name}"} for name in (
            "blue", "green", "red", "nir08", "swir16", "swir22", "lwir11", "emis", "qa_pixel",
        )},
    }
    scenes = tmp_path / "scenes"
    scenes.mkdir()
    (scenes / "cached.stac.json").write_text(json.dumps(item))
    monkeypatch.setattr(city_study, "OUTPUT", tmp_path)
    monkeypatch.setattr(city_study, "fetch_json", lambda _url: pytest.fail("unexpected STAC network request"))

    selected = city_study.pick_scene("20250401/20250430")

    assert selected["id"] == item["id"]


def test_scene_manifest_path_prefers_versioned_manifest(tmp_path, monkeypatch):
    scenes = tmp_path / "scenes"
    scenes.mkdir()
    product = "LC08_L2SP_144051_20250414_20250424_02_T1"
    legacy = scenes / f"{product}.stac.json"
    versioned = scenes / f"{product}.v{CACHE_SCHEMA_VERSION}.stac.json"
    legacy.touch()
    versioned.touch()
    monkeypatch.setattr(city_study, "OUTPUT", tmp_path)

    assert scene_manifest_path(product) == versioned


def test_cache_loader_requires_compatible_schema_and_finite_aligned_arrays(tmp_path):
    scene_id = "LC08_L2SP_144051_20250414_20250424_02_T1"
    item_metadata = {
        "stac_item_id": "LC08_L2SP_144051_20250414_02_T1",
        "sensor": "landsat-8",
        "date": "2025-04-14",
        "cloud_cover_percent": 2.0,
    }
    metadata = {
        **_scene(scene_id),
        **item_metadata,
        "scene_id": scene_id,
        "cache_schema_version": CACHE_SCHEMA_VERSION,
    }
    cache = tmp_path / "samples.npz"
    np.savez_compressed(
        cache,
        features=np.ones((3, len(FEATURES))),
        target=np.ones(3),
        east=np.array([630300.0, 630330.0, 630360.0]),
        north=np.array([1554900.0, 1554900.0, 1554900.0]),
        metadata=json.dumps(metadata),
    )

    features, target, loaded_metadata, east, north = load_cached_samples(cache, item_metadata)
    assert features.shape == (3, len(FEATURES))
    assert target.shape == east.shape == north.shape == (3,)
    assert loaded_metadata["feature_units"] == FEATURE_SCHEMA
    assert loaded_metadata["target_units"] == TARGET_UNITS
    assert loaded_metadata["preprocessing_version"] == PREPROCESSING_VERSION
    assert loaded_metadata["qa_bad_bits"] == list(QA_BAD_BITS_SET)

    metadata["cache_schema_version"] = CACHE_SCHEMA_VERSION - 1
    np.savez_compressed(
        cache,
        features=np.ones((3, len(FEATURES))),
        target=np.ones(3),
        east=np.ones(3),
        north=np.ones(3),
        metadata=json.dumps(metadata),
    )
    with pytest.raises(LandsatSceneError, match="schema version"):
        load_cached_samples(cache, item_metadata)

    metadata["cache_schema_version"] = CACHE_SCHEMA_VERSION
    np.savez_compressed(
        cache,
        features=np.ones((3, len(FEATURES))),
        target=np.array([1.0, np.nan, 1.0]),
        east=np.ones(3),
        north=np.ones(3),
        metadata=json.dumps(metadata),
    )
    with pytest.raises(LandsatSceneError, match="non-finite"):
        load_cached_samples(cache, item_metadata)


def test_spatial_holdout_is_stable_and_disjoint_across_dates():
    east = np.tile(np.arange(0.0, 9000.0, 300.0), 2)
    north = np.repeat(np.array([0.0, 900.0]), 30)
    # Repeat coordinates for a second acquisition; the same geographic blocks
    # must remain grouped together across dates.
    east = np.concatenate([east, east])
    north = np.concatenate([north, north])

    train, held_out = spatial_holdout_indices(east, north)
    train_again, held_out_again = spatial_holdout_indices(east, north)
    np.testing.assert_array_equal(train, train_again)
    np.testing.assert_array_equal(held_out, held_out_again)

    def block_ids(indices):
        return set(zip(np.floor(east[indices] / 900).astype(int), np.floor(north[indices] / 900).astype(int)))

    train_blocks = block_ids(train)
    held_out_blocks = block_ids(held_out)
    assert train_blocks.isdisjoint(held_out_blocks)
    assert all(max(abs(tx - vx), abs(ty - vy)) > 1 for tx, ty in train_blocks for vx, vy in held_out_blocks)


def test_spatial_holdout_rejects_invalid_coordinates():
    with pytest.raises(LandsatSceneError, match="finite"):
        spatial_holdout_indices(np.array([1.0, np.nan]), np.array([2.0, 3.0]))


def test_model_card_hyperparameters_match_city_study_configuration():
    card_path = Path(__file__).resolve().parents[2] / "docs/model-cards/v1.0.0.json"
    inventory = json.loads(card_path.read_text())
    card = next(card for card in inventory["cards"] if card["id"] == "heat-bengaluru-multidate-lst")

    assert card["model_configuration"]["hyperparameters"] == city_study.MODEL_PARAMETERS
