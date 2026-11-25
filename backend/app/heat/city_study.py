"""Train and evaluate a citywide Landsat LST baseline on separate acquisition dates."""
from __future__ import annotations

import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen

import numpy as np
import rasterio
from rasterio.features import geometry_mask, geometry_window
from rasterio.crs import CRS
from rasterio.warp import transform, transform_geom
from sklearn.linear_model import LinearRegression
import xgboost as xgb
from xgboost import XGBRegressor

from app.heat.landsat import (
    EMISSIVITY_SCALE,
    FEATURE_NAMES,
    FEATURE_UNITS,
    QA_BAD_BITS,
    REFLECTANCE_OFFSET,
    REFLECTANCE_SCALE,
    SURFACE_TEMPERATURE_OFFSET_K,
    SURFACE_TEMPERATURE_SCALE,
    prepare_feature_stack,
)

CATALOG = "https://planetarycomputer.microsoft.com/api"
BANDS = {
    "blue": "SR_B2", "green": "SR_B3", "red": "SR_B4", "nir08": "SR_B5",
    "swir16": "SR_B6", "swir22": "SR_B7", "lwir11": "ST_B10",
    "emis": "ST_EMIS", "qa_pixel": "QA_PIXEL",
}
FEATURES = tuple(name for name in FEATURE_NAMES if name not in {"norm_row", "norm_col"})
FEATURE_SCHEMA = {name: FEATURE_UNITS[name] for name in FEATURES}
COLLECTION_ID = "landsat-c2-l2"
PREPROCESSING_VERSION = "landsat-c2-l2-features-v2"
TARGET_UNITS = "degrees Celsius"
CACHE_SCHEMA_VERSION = 2
PIXEL_RESOLUTION_M = 30.0
SPATIAL_BLOCK_SIZE_M = 900.0
SPATIAL_BUFFER_BLOCKS = 1
SPATIAL_TEST_SIZE = 0.2
RANDOM_SEED = 42
MODEL_PARAMETERS = {
    "n_estimators": 300,
    "max_depth": 6,
    "n_jobs": 4,
    "random_state": RANDOM_SEED,
    "tree_method": "hist",
}
QA_BAD_BITS_SET = tuple(bit for bit in range(16) if QA_BAD_BITS & (1 << bit))
BOUNDARY = Path("../frontend/public/data/bengaluru-boundary.geojson")
OUTPUT = Path("data/heat/city-study")
MODEL_PATH = OUTPUT / "model.v2.json"
EVALUATION_PATH = OUTPUT / "evaluation.v2.json"
BBOX = "77.4600,12.8336,77.7844,13.1427"
TRAIN_DATES = (
    "20230201/20230228", "20230401/20230430", "20231101/20231130", "20240101/20240131",
    "20240201/20240229", "20240301/20240331", "20240401/20240430", "20240501/20240531",
    "20241101/20241130", "20241201/20241231", "20250101/20250131", "20250201/20250228",
    "20250301/20250331", "20250401/20250430", "20250501/20250531", "20251201/20251231",
)
TEST_DATES = ("20260101/20260131", "20260201/20260228", "20260301/20260331", "20260401/20260430")


class LandsatSceneError(ValueError):
    """Raised when scene metadata or a cached multi-date scene is incompatible."""


def validate_scene_item(item: dict) -> dict:
    """Validate a supported Landsat 8/9 Collection 2 Level-2 STAC item."""
    item_id = item.get("id")
    properties = item.get("properties", {})
    platform = properties.get("platform")
    date_time = properties.get("datetime")
    cloud_cover = properties.get("eo:cloud_cover")
    if item.get("collection") != COLLECTION_ID:
        raise LandsatSceneError(f"Unsupported Landsat collection for item {item_id}")
    if platform not in {"landsat-8", "landsat-9"}:
        raise LandsatSceneError(f"Unsupported Landsat sensor for item {item_id}")
    if not isinstance(item_id, str) or not item_id.startswith(("LC08_L2SP_144051_", "LC09_L2SP_144051_")):
        raise LandsatSceneError(f"Unsupported Landsat product ID: {item_id}")
    expected_prefix = "LC08" if platform == "landsat-8" else "LC09"
    if not item_id.startswith(expected_prefix):
        raise LandsatSceneError(f"STAC platform and product ID disagree for {item_id}")
    try:
        acquired = datetime.fromisoformat(str(date_time).replace("Z", "+00:00"))
    except ValueError as exc:
        raise LandsatSceneError(f"STAC item {item_id} has an invalid acquisition time") from exc
    if not acquired.tzinfo:
        raise LandsatSceneError(f"STAC item {item_id} acquisition time must include a timezone")
    if item_id.split("_")[3] != acquired.strftime("%Y%m%d"):
        raise LandsatSceneError(f"STAC item {item_id} date does not match its acquisition timestamp")
    if not isinstance(cloud_cover, (int, float)) or not math.isfinite(cloud_cover) or not 0 <= cloud_cover <= 100:
        raise LandsatSceneError(f"STAC item {item_id} has invalid scene-level cloud cover")
    if BANDS.keys() - item.get("assets", {}).keys():
        raise LandsatSceneError(f"STAC item {item_id} is missing required Level-2 assets")
    return {
        "stac_item_id": item_id,
        "collection": COLLECTION_ID,
        "sensor": platform,
        "date": acquired.date().isoformat(),
        "datetime": acquired.isoformat(),
        "cloud_cover_percent": float(cloud_cover),
    }


def _transform_values(value, *, label: str) -> tuple[float, float, float, float, float, float]:
    try:
        transform_values = tuple(float(part) for part in value[:6])
    except (TypeError, ValueError, IndexError) as exc:
        raise LandsatSceneError(f"{label} must contain six affine values") from exc
    if len(transform_values) != 6 or not all(math.isfinite(part) for part in transform_values):
        raise LandsatSceneError(f"{label} must contain six finite affine values")
    return transform_values


def validate_scene_compatibility(scenes: list[dict]) -> None:
    """Require common features/units, projected CRS, resolution and pixel lattice."""
    if not scenes:
        raise LandsatSceneError("At least one Landsat scene is required")
    reference = scenes[0]
    required = (
        "scene_id", "stac_item_id", "date", "datetime", "collection", "sensor", "crs", "source_transform", "window_transform",
        "pixel_resolution_m", "cloud_cover_percent", "feature_names", "feature_units", "target_units",
        "preprocessing_version", "qa_bad_bits",
    )
    for scene in scenes:
        scene_id = scene.get("scene_id", "unknown scene")
        missing = [key for key in required if key not in scene]
        if missing:
            raise LandsatSceneError(f"Scene {scene_id} metadata is missing: {', '.join(missing)}")
        if scene["collection"] != COLLECTION_ID or scene["sensor"] not in {"landsat-8", "landsat-9"}:
            raise LandsatSceneError(f"Scene {scene_id} is not a supported Landsat 8/9 C2 L2 product")
        expected_prefix = "LC08" if scene["sensor"] == "landsat-8" else "LC09"
        scene_parts = str(scene_id).split("_")
        stac_parts = str(scene["stac_item_id"]).split("_")
        try:
            acquired = datetime.fromisoformat(str(scene["datetime"]).replace("Z", "+00:00"))
        except ValueError as exc:
            raise LandsatSceneError(f"Scene {scene_id} has an invalid acquisition time") from exc
        if (
            len(scene_parts) < 7
            or scene_parts[0] != expected_prefix
            or scene_parts[3] != str(scene["date"]).replace("-", "")
            or len(stac_parts) < 6
            or stac_parts[0] != expected_prefix
            or stac_parts[3] != str(scene["date"]).replace("-", "")
            or acquired.date().isoformat() != scene["date"]
            or not acquired.tzinfo
        ):
            raise LandsatSceneError(f"Scene {scene_id} sensor, product date, and acquisition metadata disagree")
        if not isinstance(scene["cloud_cover_percent"], (int, float)) or not 0 <= scene["cloud_cover_percent"] <= 100:
            raise LandsatSceneError(f"Scene {scene_id} has invalid scene-level cloud cover")
        if scene["feature_names"] != list(FEATURES) or scene["feature_units"] != FEATURE_SCHEMA:
            raise LandsatSceneError(f"Scene {scene_id} feature names, order, or units are incompatible")
        if scene["target_units"] != TARGET_UNITS or scene["preprocessing_version"] != PREPROCESSING_VERSION:
            raise LandsatSceneError(f"Scene {scene_id} target units or preprocessing version are incompatible")
        if scene["qa_bad_bits"] != list(QA_BAD_BITS_SET):
            raise LandsatSceneError(f"Scene {scene_id} QA mask differs from the configured Landsat mask")
        try:
            crs = CRS.from_user_input(scene["crs"])
        except (TypeError, ValueError) as exc:
            raise LandsatSceneError(f"Scene {scene_id} has an invalid CRS") from exc
        if not crs.is_projected:
            raise LandsatSceneError(f"Scene {scene_id} must use a projected CRS")
        if not math.isclose(float(scene["pixel_resolution_m"]), PIXEL_RESOLUTION_M, abs_tol=1e-6):
            raise LandsatSceneError(f"Scene {scene_id} has an incompatible pixel resolution")
        source = _transform_values(scene["source_transform"], label=f"Scene {scene_id} source transform")
        window = _transform_values(scene["window_transform"], label=f"Scene {scene_id} AOI transform")
        for label, affine in (("source", source), ("AOI window", window)):
            if not math.isclose(affine[0], PIXEL_RESOLUTION_M, abs_tol=1e-6) or not math.isclose(affine[4], -PIXEL_RESOLUTION_M, abs_tol=1e-6):
                raise LandsatSceneError(f"Scene {scene_id} {label} transform must be north-up at 30 m")
            if not math.isclose(affine[1], 0.0, abs_tol=1e-9) or not math.isclose(affine[3], 0.0, abs_tol=1e-9):
                raise LandsatSceneError(f"Scene {scene_id} {label} transform rotation is unsupported")
        if not math.isclose((window[2] - source[2]) / PIXEL_RESOLUTION_M, round((window[2] - source[2]) / PIXEL_RESOLUTION_M), abs_tol=1e-6):
            raise LandsatSceneError(f"Scene {scene_id} AOI transform is off its source pixel lattice")
        if not math.isclose((window[5] - source[5]) / -PIXEL_RESOLUTION_M, round((window[5] - source[5]) / -PIXEL_RESOLUTION_M), abs_tol=1e-6):
            raise LandsatSceneError(f"Scene {scene_id} AOI transform is off its source pixel lattice")

        for key in ("collection", "crs", "pixel_resolution_m", "feature_names", "feature_units", "target_units", "preprocessing_version", "qa_bad_bits"):
            if scene[key] != reference[key]:
                raise LandsatSceneError(f"Scene {scene_id} has incompatible {key}")
        reference_window = _transform_values(reference["window_transform"], label="Reference AOI transform")
        if any(not math.isclose(window[index], reference_window[index], abs_tol=1e-6) for index in range(6)):
            raise LandsatSceneError(f"Scene {scene_id} AOI window does not align with the common grid")
        reference_source = _transform_values(reference["source_transform"], label="Reference source transform")
        for offset, axis in ((2, "x"), (5, "y")):
            pixel_delta = (source[offset] - reference_source[offset]) / PIXEL_RESOLUTION_M
            if not math.isclose(pixel_delta, round(pixel_delta), abs_tol=1e-6):
                raise LandsatSceneError(f"Scene {scene_id} source transform is off the common pixel lattice ({axis})")


def spatial_holdout_indices(
    east: np.ndarray,
    north: np.ndarray,
    *,
    test_size: float = SPATIAL_TEST_SIZE,
    seed: int = RANDOM_SEED,
) -> tuple[np.ndarray, np.ndarray]:
    """Split all dates by stable projected 900 m blocks to prevent spatial leakage."""
    east = np.asarray(east, dtype=np.float64).ravel()
    north = np.asarray(north, dtype=np.float64).ravel()
    if east.shape != north.shape or not len(east) or not np.isfinite(east).all() or not np.isfinite(north).all():
        raise LandsatSceneError("Spatial holdout coordinates must be non-empty, aligned, and finite")
    if not 0.0 < test_size < 1.0:
        raise LandsatSceneError("Spatial holdout test_size must be between zero and one")
    block_xy = np.column_stack((np.floor(east / SPATIAL_BLOCK_SIZE_M), np.floor(north / SPATIAL_BLOCK_SIZE_M))).astype(np.int64)
    unique_blocks, groups = np.unique(block_xy, axis=0, return_inverse=True)
    if len(unique_blocks) < 3:
        raise LandsatSceneError("Spatial holdout needs at least three 900 m projected blocks")
    rng = np.random.default_rng(seed)
    test_block_count = min(max(int(round(len(unique_blocks) * test_size)), 1), len(unique_blocks) - 2)
    test_blocks = rng.choice(len(unique_blocks), test_block_count, replace=False)
    test_coordinates = unique_blocks[test_blocks]
    within_buffer = np.zeros(len(unique_blocks), dtype=bool)
    for test_block in test_coordinates:
        within_buffer |= np.max(np.abs(unique_blocks - test_block), axis=1) <= SPATIAL_BUFFER_BLOCKS
    train_block_ids = np.flatnonzero(~within_buffer)
    if not len(train_block_ids):
        raise LandsatSceneError("Spatial holdout buffer removed every training block")
    train_mask = np.isin(groups, train_block_ids)
    test_mask = np.isin(groups, test_blocks)
    train_indices = np.flatnonzero(train_mask)
    test_indices = np.flatnonzero(test_mask)
    return train_indices, test_indices


def load_cached_samples(cache_path: str | Path, item_metadata: dict) -> tuple[np.ndarray, np.ndarray, dict, np.ndarray, np.ndarray]:
    """Load only a versioned cache whose identity and arrays match the schema."""
    with np.load(cache_path, allow_pickle=False) as saved:
        required_arrays = {"features", "target", "east", "north", "metadata"}
        if not required_arrays <= set(saved.files):
            raise LandsatSceneError(f"Cached scene {Path(cache_path).name} is missing required arrays")
        features = saved["features"]
        target = saved["target"]
        east = saved["east"]
        north = saved["north"]
        try:
            metadata = json.loads(str(saved["metadata"]))
        except (TypeError, json.JSONDecodeError) as exc:
            raise LandsatSceneError("Cached scene metadata is not valid JSON") from exc
    if "cloud_cover_percent" not in metadata:
        metadata["cloud_cover_percent"] = item_metadata["cloud_cover_percent"]
    _validate_cached_arrays(features, target, east, north, metadata, item_metadata)
    return features, target, metadata, east, north


def scene_manifest_path(product: str) -> Path:
    """Resolve a versioned scene manifest, with support for legacy local manifests."""
    folder = OUTPUT / "scenes"
    versioned = folder / f"{product}.v{CACHE_SCHEMA_VERSION}.stac.json"
    legacy = folder / f"{product}.stac.json"
    if versioned.is_file():
        return versioned
    if legacy.is_file():
        return legacy
    raise LandsatSceneError(f"STAC manifest for Landsat product {product} is not available")


def _validate_cached_arrays(features, target, east, north, metadata: dict, item_metadata: dict) -> None:
    n = len(target)
    if features.shape != (n, len(FEATURES)) or east.shape != (n,) or north.shape != (n,):
        raise LandsatSceneError(f"Cached scene {metadata.get('scene_id', 'unknown')} has incompatible array shapes")
    if not n or not all(np.isfinite(array).all() for array in (features, target, east, north)):
        raise LandsatSceneError(f"Cached scene {metadata.get('scene_id', 'unknown')} contains empty or non-finite samples")
    if metadata.get("stac_item_id") != item_metadata["stac_item_id"] or metadata.get("date") != item_metadata["date"] or metadata.get("sensor") != item_metadata["sensor"]:
        raise LandsatSceneError("Cached scene identity does not match the current STAC item")
    if "cloud_cover_percent" in metadata and metadata["cloud_cover_percent"] != item_metadata["cloud_cover_percent"]:
        raise LandsatSceneError("Cached scene cloud cover does not match the current STAC item")
    if metadata.get("cache_schema_version") != CACHE_SCHEMA_VERSION:
        raise LandsatSceneError("Cached scene schema version is incompatible")
    expected_prefix = "LC08_L2SP_144051_" if item_metadata["sensor"] == "landsat-8" else "LC09_L2SP_144051_"
    if not str(metadata.get("scene_id", "")).startswith(expected_prefix) or not str(metadata.get("scene_id", "")).split("_")[3] == item_metadata["date"].replace("-", ""):
        raise LandsatSceneError("Cached thermal product ID does not match the STAC item")
    validate_scene_compatibility([metadata])


def fetch_json(url: str) -> dict:
    with urlopen(url, timeout=30) as response:
        return json.load(response)


def pick_scene(period: str) -> dict:
    start, end = period.split("/")
    start_date = date.fromisoformat(f"{start[:4]}-{start[4:6]}-{start[6:]}")
    end_date = date.fromisoformat(f"{end[:4]}-{end[4:6]}-{end[6:]}")
    cached = {}
    for path in (OUTPUT / "scenes").glob("*.stac.json"):
        try:
            item = json.loads(path.read_text())
            metadata = validate_scene_item(item)
            acquired = date.fromisoformat(metadata["date"])
        except (OSError, json.JSONDecodeError, LandsatSceneError, ValueError):
            continue
        if start_date <= acquired <= end_date:
            cached[item["id"]] = item
    if cached:
        return min(
            cached.values(),
            key=lambda item: (item["properties"].get("eo:cloud_cover", float("inf")), item["id"]),
        )

    def fmt(date: str) -> str:
        return f"{date[:4]}-{date[4:6]}-{date[6:]}"
    query = urlencode({
        "collections": "landsat-c2-l2", "bbox": BBOX,
        "datetime": f"{fmt(start)}/{fmt(end)}", "limit": 100,
    })
    items = fetch_json(f"{CATALOG}/stac/v1/search?{query}")["features"]
    eligible = [
        item for item in items
        if item["id"].startswith(("LC08_L2SP_144051", "LC09_L2SP_144051"))
        and BANDS.keys() <= item["assets"].keys()
    ]
    if not eligible:
        raise RuntimeError(f"No compatible scene in {period}")
    return min(eligible, key=lambda item: (item["properties"]["eo:cloud_cover"], item["id"]))


def scene_samples(
    item: dict, geometry: dict, sample_limit: int | None
) -> tuple[np.ndarray, np.ndarray, dict, np.ndarray, np.ndarray]:
    item_metadata = validate_scene_item(item)
    product = item["assets"]["lwir11"]["href"].rsplit("/", 1)[-1].removesuffix("_ST_B10.TIF")
    if not product.startswith(("LC08_L2SP_144051_", "LC09_L2SP_144051_")):
        raise LandsatSceneError(f"Unsupported thermal asset product ID: {product}")
    product_parts = product.split("_")
    if product_parts[0] != ("LC08" if item_metadata["sensor"] == "landsat-8" else "LC09") or product_parts[3] != item_metadata["date"].replace("-", ""):
        raise LandsatSceneError(f"STAC item and thermal asset identity disagree for {product}")
    folder = OUTPUT / "scenes"
    folder.mkdir(parents=True, exist_ok=True)
    stac_path = folder / f"{product}.v{CACHE_SCHEMA_VERSION}.stac.json"
    if not stac_path.exists():
        stac_path.write_text(json.dumps(item, indent=2))
    cache = folder / f"{product}.v{CACHE_SCHEMA_VERSION}.{sample_limit or 'all'}.npz"
    if cache.exists():
        return load_cached_samples(cache, item_metadata)

    thermal_url = urlsplit(item["assets"]["lwir11"]["href"])
    account = thermal_url.hostname.split(".")[0]
    container = thermal_url.path.split("/")[1]
    token = fetch_json(f"{CATALOG}/sas/v1/token/{account}/{container}")["token"].lstrip("?")
    arrays = {}
    reference = None
    source_transform = None
    with rasterio.Env(GDAL_HTTP_TIMEOUT="30", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        for key, band in BANDS.items():
            url = item["assets"][key]["href"]
            if not url.startswith(f"https://{thermal_url.hostname}/{container}/"):
                raise ValueError("Unexpected Landsat asset host")
            with rasterio.open(f"{url}?{token}") as src:
                profile = (src.crs, src.transform, src.width, src.height)
                if reference is None:
                    reference = profile
                    source_transform = src.transform
                    projected = transform_geom("EPSG:4326", src.crs, geometry)
                    window = geometry_window(src, [projected])
                    affine = src.window_transform(window)
                if profile != reference:
                    raise ValueError("Landsat scene bands are misaligned")
                arrays[band] = src.read(1, window=window)
    qa = arrays.pop("QA_PIXEL")
    city_mask = geometry_mask([projected], out_shape=qa.shape, transform=affine, invert=True)
    stack = prepare_feature_stack(
        arrays, qa, scene_id=product, acquisition_date=item_metadata["date"].replace("-", ""),
        crs=reference[0].to_string(), transform=affine, aoi_mask=city_mask,
    )
    valid = np.flatnonzero(stack.valid_mask)
    if not valid.size:
        raise ValueError("No valid municipal pixels")
    if sample_limit and valid.size > sample_limit:
        sample = np.sort(np.random.default_rng(42).choice(valid, sample_limit, replace=False))
    else:
        sample = valid
    features = np.column_stack([stack.features[name].ravel()[sample] for name in FEATURES])
    target = stack.lst_c.ravel()[sample]
    metadata = {
        **item_metadata,
        "scene_id": product,
        "feature_names": list(FEATURES),
        "feature_units": FEATURE_SCHEMA,
        "target_units": TARGET_UNITS,
        "crs": stack.crs,
        "source_transform": list(source_transform)[:6],
        "window_transform": list(affine)[:6],
        "pixel_resolution_m": stack.pixel_resolution_m,
        "preprocessing_version": PREPROCESSING_VERSION,
        "qa_bad_bits": list(QA_BAD_BITS_SET),
        "valid_pixels": int(valid.size),
        "city_pixels": int(city_mask.sum()),
        "used_pixels": len(sample),
        "sample_limit": sample_limit,
        "cache_schema_version": CACHE_SCHEMA_VERSION,
    }
    validate_scene_compatibility([metadata])
    rows, cols = np.unravel_index(sample, qa.shape)
    east, north = rasterio.transform.xy(affine, rows, cols, offset="center")
    east = np.asarray(east, dtype=np.float64)
    north = np.asarray(north, dtype=np.float64)
    np.savez_compressed(
        cache, features=features, target=target, metadata=json.dumps(metadata),
        east=east, north=north, crs=stack.crs,
    )
    print(metadata, flush=True)
    _validate_cached_arrays(features, target, east, north, metadata, item_metadata)
    return features, target, metadata, east, north


def metrics(target: np.ndarray, predictions: np.ndarray) -> dict:
    error = predictions - target
    return {
        "rmse_c": float(np.sqrt(np.mean(error**2))),
        "mae_c": float(np.mean(np.abs(error))),
        "bias_c": float(np.mean(error)),
    }


def main() -> None:
    if tuple(FEATURES) != tuple(name for name in FEATURE_NAMES if name not in {"norm_row", "norm_col"}):
        raise LandsatSceneError("Configured city-study feature order differs from the shared Landsat schema")
    geometry = json.loads(BOUNDARY.read_text())["geometry"]
    # Keep signed raster-token requests below the provider's public API rate limits.
    with ThreadPoolExecutor(max_workers=2) as pool:
        items = list(pool.map(pick_scene, (*TRAIN_DATES, *TEST_DATES)))
        jobs = [(item, 30_000 if index < len(TRAIN_DATES) else 100_000) for index, item in enumerate(items)]
        results = list(pool.map(lambda job: scene_samples(job[0], geometry, job[1]), jobs))
    train = results[:len(TRAIN_DATES)]
    test = results[len(TRAIN_DATES):]
    validate_scene_compatibility([row[2] for row in results])
    if max(row[2]["date"] for row in train) >= min(row[2]["date"] for row in test):
        raise ValueError("Training dates must precede every evaluation date")
    train_x = np.concatenate([row[0] for row in train])
    train_y = np.concatenate([row[1] for row in train])
    train_east = np.concatenate([row[3] for row in train])
    train_north = np.concatenate([row[4] for row in train])

    spatial_train, spatial_test = spatial_holdout_indices(train_east, train_north)
    spatial_model = XGBRegressor(**MODEL_PARAMETERS)
    spatial_model.fit(train_x[spatial_train], train_y[spatial_train])
    spatial_linear = LinearRegression().fit(train_x[spatial_train], train_y[spatial_train])
    spatial_blocks = np.column_stack((
        np.floor(train_east / SPATIAL_BLOCK_SIZE_M),
        np.floor(train_north / SPATIAL_BLOCK_SIZE_M),
    )).astype(np.int64)
    _, block_ids = np.unique(spatial_blocks, axis=0, return_inverse=True)
    spatial_eval = {
        "split_strategy": "Grouped holdout by stable projected-coordinate blocks pooled across all training acquisitions",
        "block_crs": "EPSG:32643",
        "block_size_m": SPATIAL_BLOCK_SIZE_M,
        "buffer_blocks": SPATIAL_BUFFER_BLOCKS,
        "test_size": SPATIAL_TEST_SIZE,
        "random_seed": RANDOM_SEED,
        "train_blocks": int(len(np.unique(block_ids[spatial_train]))),
        "test_blocks": int(len(np.unique(block_ids[spatial_test]))),
        "train_pixels": int(len(spatial_train)),
        "test_pixels": int(len(spatial_test)),
        "xgboost": metrics(train_y[spatial_test], spatial_model.predict(train_x[spatial_test])),
        "linear_baseline": metrics(train_y[spatial_test], spatial_linear.predict(train_x[spatial_test])),
        "training_mean_baseline": metrics(train_y[spatial_test], np.full(len(spatial_test), train_y[spatial_train].mean())),
    }

    model = XGBRegressor(**MODEL_PARAMETERS)
    model.fit(train_x, train_y)
    linear = LinearRegression().fit(train_x, train_y)
    evaluations = []
    for features, target, manifest, _, _ in test:
        evaluations.append({
            **manifest,
            "xgboost": metrics(target, model.predict(features)),
            "linear_baseline": metrics(target, linear.predict(features)),
            "training_mean_baseline": metrics(target, np.full_like(target, train_y.mean())),
        })
    report = {
        "target": "Same-acquisition Landsat Level-2 surface temperature (°C), clear municipal pixels",
        "evaluation": "Separate spatial-block evaluation across training acquisitions and chronological holdout by entire later acquisition dates",
        "source": "Remotely sensed USGS Landsat Collection 2 Level-2 imagery accessed through Microsoft Planetary Computer STAC",
        "source_collection_url": f"{CATALOG}/stac/v1/collections/{COLLECTION_ID}",
        "collection": COLLECTION_ID,
        "sensor_family": "Landsat 8/9 Collection 2 Level-2; per-scene sensor recorded in manifests",
        "scene_selection": "Lowest scene-level cloud cover per configured date range, path 144 row 051",
        "training_date_ranges": TRAIN_DATES,
        "chronological_test_date_ranges": TEST_DATES,
        "samples_per_scene": {"training": 30_000, "chronological_test": 100_000, "selection_seed": RANDOM_SEED},
        "crs": "EPSG:32643",
        "pixel_resolution_m": PIXEL_RESOLUTION_M,
        "preprocessing_scales": {
            "surface_reflectance_scale": REFLECTANCE_SCALE,
            "surface_reflectance_offset": REFLECTANCE_OFFSET,
            "surface_temperature_scale": SURFACE_TEMPERATURE_SCALE,
            "surface_temperature_offset_kelvin": SURFACE_TEMPERATURE_OFFSET_K,
            "emissivity_scale": EMISSIVITY_SCALE,
        },
        "features": FEATURES,
        "feature_units": FEATURE_SCHEMA,
        "target_units": TARGET_UNITS,
        "preprocessing_version": PREPROCESSING_VERSION,
        "qa_bad_bits": QA_BAD_BITS_SET,
        "xgboost_version": xgb.__version__,
        "random_seed": RANDOM_SEED,
        "train_pixels": len(train_y),
        "spatial_block_evaluation": spatial_eval,
        "model_parameters": MODEL_PARAMETERS,
        "xgboost_version": xgb.__version__,
        "training": [row[2] for row in train],
        "test": evaluations,
    }
    model.save_model(MODEL_PATH)
    EVALUATION_PATH.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(evaluations, indent=2))


def export_map() -> None:
    """Aggregate one held-out acquisition to 300 m cells for browser display."""
    report = json.loads(EVALUATION_PATH.read_text())
    selected = max(report["test"], key=lambda row: row["date"])
    product = selected["scene_id"]
    item = json.loads(scene_manifest_path(product).read_text())
    geometry = json.loads(BOUNDARY.read_text())["geometry"]
    features, _, metadata, east, north = scene_samples(item, geometry, None)
    if metadata["crs"] != "EPSG:32643":
        raise LandsatSceneError(f"Unexpected municipal scene CRS: {metadata['crs']}")
    model = XGBRegressor(n_jobs=4)
    model.load_model(MODEL_PATH)
    values = model.predict(features)
    cells, inverse = np.unique(np.column_stack([east, north]) // 300, return_inverse=True, axis=0)
    inverse = inverse.ravel()
    count = np.bincount(inverse)
    mean = np.bincount(inverse, weights=values) / count
    lngs, lats = transform(crs, "EPSG:4326", cells[:, 0] * 300 + 150, cells[:, 1] * 300 + 150)
    output = {
        "scene_id": product, "date": selected["date"], "resolution_m": 300,
        "valid_pixel_fraction": metadata["valid_pixels"] / metadata["city_pixels"],
        "rmse_c": selected["xgboost"]["rmse_c"],
        "cells": [
            [round(lng, 6), round(lat, 6), round(value, 2), f"{int(i)}:{int(j)}"]
            for lng, lat, value, (i, j) in zip(lngs, lats, mean, cells)
        ],
    }
    BOUNDARY.with_name("bengaluru-heat.json").write_text(json.dumps(output, separators=(",", ":")) + "\n")
    print(f"Exported {len(cells)} municipal heat cells from {selected['date']}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-map", action="store_true")
    if parser.parse_args().export_map:
        export_map()
    else:
        main()
