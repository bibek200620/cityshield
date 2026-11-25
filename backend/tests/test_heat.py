from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest
import rasterio
import xgboost as xgb
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds
from xgboost import XGBRegressor

from app.heat.landsat import (
    FEATURE_NAMES,
    LANDSAT_BANDS,
    LandsatDataError,
    load_landsat_scene,
    prepare_feature_stack,
)
from app.heat.model import (
    HeatModelError,
    load_compatible_model,
    spatial_holdout_indices,
    summarize_heat_shap,
)

SCENE_ID = "LC08_L2SP_144051_20250414_20250424_02_T1"
BBOX = (77.655, 12.915, 77.680, 12.940)


def _arrays(shape=(8, 8)):
    return {
        "SR_B2": np.full(shape, 10000, dtype=np.uint16),
        "SR_B3": np.full(shape, 12000, dtype=np.uint16),
        "SR_B4": np.full(shape, 11000, dtype=np.uint16),
        "SR_B5": np.full(shape, 20000, dtype=np.uint16),
        "SR_B6": np.full(shape, 14000, dtype=np.uint16),
        "SR_B7": np.full(shape, 13000, dtype=np.uint16),
        "ST_B10": np.full(shape, 45000, dtype=np.uint16),
        "ST_EMIS": np.full(shape, 9500, dtype=np.uint16),
    }


def _stack(shape=(8, 8)):
    arrays = _arrays(shape)
    return prepare_feature_stack(
        arrays,
        np.zeros(shape, dtype=np.uint16),
        scene_id=SCENE_ID,
        acquisition_date="20250414",
        crs="EPSG:32643",
        transform=from_bounds(300000, 1400000, 300000 + shape[1] * 30, 1400000 + shape[0] * 30, shape[1], shape[0]),
    )


def _write_scene_bundle(root, *, width=8, height=8):
    west, south, east, north = transform_bounds("EPSG:4326", "EPSG:32643", *BBOX)
    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": 1,
        "dtype": "uint16",
        "crs": "EPSG:32643",
        "transform": from_bounds(west, south, east, north, width, height),
        "nodata": 0,
    }
    arrays = _arrays((height, width))
    arrays["QA_PIXEL"] = np.zeros((height, width), dtype=np.uint16)
    for band in (*LANDSAT_BANDS, "QA_PIXEL"):
        with rasterio.open(root / f"{SCENE_ID}_{band}.TIF", "w", **profile) as ds:
            ds.write(arrays[band], 1)


def test_feature_order_units_mask_and_missing_values():
    arrays = _arrays()
    qa = np.zeros((8, 8), dtype=np.uint16)
    qa[0, 0] = 1 << 3  # QA_PIXEL cloud flag
    arrays["SR_B2"][1, 1] = 0  # Collection 2 fill value
    stack = prepare_feature_stack(
        arrays,
        qa,
        scene_id=SCENE_ID,
        acquisition_date="20250414",
        crs="EPSG:32643",
        transform=from_bounds(0, 0, 240, 240, 8, 8),
    )

    assert tuple(stack.features) == FEATURE_NAMES
    assert stack.valid_mask.sum() == 62
    assert np.isnan(stack.lst_c[0, 0])
    assert np.isnan(stack.features["NDVI"][1, 1])
    assert stack.features["NDVI"][2, 2] == pytest.approx(
        ((20000 * 0.0000275 - 0.2) - (11000 * 0.0000275 - 0.2))
        / ((20000 * 0.0000275 - 0.2) + (11000 * 0.0000275 - 0.2))
    )
    assert stack.lst_c[2, 2] == pytest.approx(45000 * 0.00341802 + 149 - 273.15)


def test_missing_band_and_misaligned_shape_are_rejected():
    arrays = _arrays()
    del arrays["SR_B4"]
    with pytest.raises(LandsatDataError, match="SR_B4"):
        prepare_feature_stack(
            arrays,
            np.zeros((8, 8), dtype=np.uint16),
            scene_id=SCENE_ID,
            acquisition_date="20250414",
            crs="EPSG:32643",
            transform=from_bounds(0, 0, 240, 240, 8, 8),
        )

    arrays = _arrays()
    arrays["SR_B4"] = np.zeros((7, 8), dtype=np.uint16)
    with pytest.raises(LandsatDataError, match="aligned"):
        prepare_feature_stack(
            arrays,
            np.zeros((8, 8), dtype=np.uint16),
            scene_id=SCENE_ID,
            acquisition_date="20250414",
            crs="EPSG:32643",
            transform=from_bounds(0, 0, 240, 240, 8, 8),
        )


def test_scene_loader_validates_crs_and_converts_to_projected_grid(tmp_path):
    _write_scene_bundle(tmp_path)
    stack = load_landsat_scene(tmp_path, BBOX)

    assert stack.scene_id == SCENE_ID
    assert stack.acquisition_date == "20250414"
    assert stack.crs == "EPSG:32643"
    assert stack.pixel_resolution_m > 0
    assert stack.valid_mask.any()
    x, y = rasterio.transform.xy(stack.transform, 0, 0, offset="center")
    assert 0 < x < 1_000_000 and 0 < y < 10_000_000


def test_spatial_holdout_keeps_pixel_blocks_disjoint():
    rows, cols = np.indices((90, 90))
    train, test = spatial_holdout_indices(rows.ravel(), cols.ravel())
    block_ids = (rows.ravel() // 30) * 3 + cols.ravel() // 30
    assert set(block_ids[train]).isdisjoint(set(block_ids[test]))


def test_model_loader_checks_artifacts_and_feature_order(tmp_path):
    stack = _stack()
    path = tmp_path / "model.json"
    frame = pd.DataFrame({name: stack.features[name][stack.valid_mask] for name in FEATURE_NAMES})
    target = stack.lst_c[stack.valid_mask]
    model = XGBRegressor(n_estimators=2, max_depth=1, n_jobs=1, tree_method="hist", random_state=42)
    model.fit(frame, target)
    model.save_model(path)
    metadata = {
        "schema_version": 1,
        "model_type": "XGBRegressor",
        "model_version": xgb.__version__,
        "feature_names": list(FEATURE_NAMES),
        "feature_units": {
            "NDVI": "unitless",
            "NDBI": "unitless",
            "EMIS": "unitless",
            "MNDWI": "unitless",
            "norm_row": "normalized pixel row [0,1]",
            "norm_col": "normalized pixel column [0,1]",
            "ALBEDO": "unitless",
            "BSI": "unitless",
        },
        "source_scene_id": stack.scene_id,
        "crs": stack.crs,
        "artifact_format": "XGBoost JSON",
        "preprocessing_version": "landsat-c2-l2-features-v1",
        "target_units": "degrees Celsius",
    }
    path.with_suffix(".metadata.json").write_text(json.dumps(metadata))

    loaded, loaded_metadata = load_compatible_model(stack, path)
    assert loaded.get_booster().feature_names == list(FEATURE_NAMES)
    assert loaded_metadata["source_scene_id"] == SCENE_ID
    sample_size, summary = summarize_heat_shap(stack, loaded)
    contributions = loaded.get_booster().predict(xgb.DMatrix(frame), pred_contribs=True)
    assert sample_size == len(frame)
    assert set(summary) == set(FEATURE_NAMES)
    np.testing.assert_allclose(
        [summary[name] for name in FEATURE_NAMES],
        np.abs(contributions[:, :-1]).mean(axis=0),
    )

    metadata["feature_names"] = list(reversed(FEATURE_NAMES))
    path.with_suffix(".metadata.json").write_text(json.dumps(metadata))
    with pytest.raises(HeatModelError, match="feature_names"):
        load_compatible_model(stack, path)

    with pytest.raises(HeatModelError, match="not available"):
        load_compatible_model(stack, tmp_path / "missing.json")

    metadata["feature_names"] = list(FEATURE_NAMES)
    metadata["crs"] = "EPSG:4326"
    path.with_suffix(".metadata.json").write_text(json.dumps(metadata))
    with pytest.raises(HeatModelError, match="crs"):
        load_compatible_model(stack, path)
