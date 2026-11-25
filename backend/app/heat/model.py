"""Spatially held-out XGBoost model for one Landsat surface-temperature scene."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import rasterio
from rasterio.warp import transform
from sklearn.metrics import mean_squared_error, r2_score
from sklearn.model_selection import GroupShuffleSplit

from app.heat.landsat import FEATURE_NAMES, FEATURE_UNITS, HeatSceneStack

MODEL_SCHEMA_VERSION = 1
SPATIAL_BLOCK_PIXELS = 30
RANDOM_SEED = 42
MODEL_PARAMETERS = {
    "n_estimators": 600,
    "learning_rate": 0.05,
    "max_depth": 6,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "objective": "reg:squarederror",
    "tree_method": "hist",
    "n_jobs": 1,
    "random_state": RANDOM_SEED,
}


class HeatModelError(ValueError):
    """Raised when an artifact is absent or incompatible with its input scene."""


def _feature_frame(stack: HeatSceneStack) -> pd.DataFrame:
    return pd.DataFrame({name: stack.features[name][stack.valid_mask] for name in FEATURE_NAMES})


def spatial_holdout_indices(
    rows: np.ndarray,
    cols: np.ndarray,
    *,
    test_size: float = 0.2,
    seed: int = RANDOM_SEED,
) -> tuple[np.ndarray, np.ndarray]:
    """Split whole spatial tiles, never neighboring individual pixels."""
    groups = (rows // SPATIAL_BLOCK_PIXELS) * (int(cols.max()) // SPATIAL_BLOCK_PIXELS + 1) + (
        cols // SPATIAL_BLOCK_PIXELS
    )
    unique_groups = np.unique(groups)
    if len(unique_groups) < 2:
        raise HeatModelError("Spatial holdout needs at least two 30-pixel blocks")
    splitter = GroupShuffleSplit(n_splits=1, test_size=test_size, random_state=seed)
    train_indices, test_indices = next(splitter.split(np.zeros(len(groups)), groups=groups))
    return train_indices, test_indices


def train_heat_model(stack: HeatSceneStack, model_path: str | Path) -> dict[str, Any]:
    """Train from one real scene, save a JSON model and reproducibility metadata."""
    try:
        import xgboost as xgb
        from xgboost import XGBRegressor
    except ImportError as exc:  # pragma: no cover - dependency installed by requirements
        raise HeatModelError("Install the pinned xgboost dependency before training") from exc

    rows, cols = np.nonzero(stack.valid_mask)
    if len(rows) < 4:
        raise HeatModelError("Scene has too few quality-masked pixels for spatial holdout")
    x = _feature_frame(stack)
    y = stack.lst_c[stack.valid_mask]
    train_idx, test_idx = spatial_holdout_indices(rows, cols)

    model = XGBRegressor(**MODEL_PARAMETERS)
    model.fit(x.iloc[train_idx], y[train_idx], verbose=False)
    predicted = model.predict(x.iloc[test_idx])
    rmse = float(np.sqrt(mean_squared_error(y[test_idx], predicted)))
    r2 = float(r2_score(y[test_idx], predicted))

    path = Path(model_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    model.save_model(path)
    metadata = {
        "schema_version": MODEL_SCHEMA_VERSION,
        "model_type": "XGBRegressor",
        "model_version": xgb.__version__,
        "artifact_format": "XGBoost JSON",
        "source": "USGS Landsat Collection 2 Level-2 scene; user-provided local files",
        "source_scene_id": stack.scene_id,
        "acquisition_date": stack.acquisition_date,
        "feature_names": list(FEATURE_NAMES),
        "feature_units": FEATURE_UNITS,
        "target": "Landsat Level-2 surface temperature",
        "target_units": "degrees Celsius",
        "crs": stack.crs,
        "pixel_resolution_m": stack.pixel_resolution_m,
        "preprocessing_version": "landsat-c2-l2-features-v1",
        "split_strategy": f"GroupShuffleSplit by {SPATIAL_BLOCK_PIXELS}x{SPATIAL_BLOCK_PIXELS}-pixel tiles",
        "test_size": 0.2,
        "random_seed": RANDOM_SEED,
        "hyperparameters": MODEL_PARAMETERS,
        "metrics": {
            "rmse_c": rmse,
            "r2": r2,
            "train_pixels": int(len(train_idx)),
            "test_pixels": int(len(test_idx)),
            "metric_scope": "spatial holdout within this single Landsat acquisition; not temporal or city-wide validation",
        },
    }
    path.with_suffix(".metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    return metadata


def load_compatible_model(
    stack: HeatSceneStack,
    model_path: str | Path,
):
    """Load only an artifact matching features, exact scene, CRS and XGBoost version."""
    path = Path(model_path)
    metadata_path = path.with_suffix(".metadata.json")
    if not path.is_file() or not metadata_path.is_file():
        raise HeatModelError("Compatible model and metadata artifact are not available")
    try:
        import xgboost as xgb
        from xgboost import XGBRegressor
    except ImportError as exc:  # pragma: no cover - dependency installed by requirements
        raise HeatModelError("XGBoost is not installed") from exc
    try:
        metadata = json.loads(metadata_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise HeatModelError("Model metadata is missing or invalid JSON") from exc

    checks = {
        "schema_version": MODEL_SCHEMA_VERSION,
        "model_type": "XGBRegressor",
        "model_version": xgb.__version__,
        "feature_names": list(FEATURE_NAMES),
        "feature_units": FEATURE_UNITS,
        "source_scene_id": stack.scene_id,
        "crs": stack.crs,
        "artifact_format": "XGBoost JSON",
        "preprocessing_version": "landsat-c2-l2-features-v1",
        "target_units": "degrees Celsius",
    }
    for key, expected in checks.items():
        if metadata.get(key) != expected:
            raise HeatModelError(f"Model metadata mismatch for {key}")

    model = XGBRegressor()
    try:
        model.load_model(path)
    except Exception as exc:
        raise HeatModelError("XGBoost model artifact could not be loaded") from exc
    model_features = model.get_booster().feature_names
    if model_features != list(FEATURE_NAMES):
        raise HeatModelError("Model feature order does not match the Landsat input schema")
    return model, metadata


def summarize_heat_shap(stack: HeatSceneStack, model) -> tuple[int, dict[str, float]]:
    """Rank features by mean absolute TreeSHAP on up to 256 valid scene pixels."""
    from xgboost import DMatrix
    from xgboost.core import XGBoostError

    frame = _feature_frame(stack)
    sample_size = min(256, len(frame))
    if not sample_size:
        raise HeatModelError("No valid pixels for a heat explanation")
    indices = np.linspace(0, len(frame) - 1, num=sample_size, dtype=int)
    try:
        contributions = model.get_booster().predict(
            DMatrix(frame.iloc[indices], nthread=1), pred_contribs=True,
        )
    except XGBoostError as exc:
        raise HeatModelError("This model could not produce TreeSHAP values") from exc
    if contributions.shape != (sample_size, len(FEATURE_NAMES) + 1) or not np.isfinite(contributions).all():
        raise HeatModelError("The model returned invalid TreeSHAP values")
    # The last column is the model bias, rather than an input feature.
    mean_absolute = np.abs(contributions[:, :-1]).mean(axis=0)
    ranked = sorted(zip(FEATURE_NAMES, mean_absolute), key=lambda pair: -pair[1])
    return sample_size, {name: float(value) for name, value in ranked}


def predict_heat_cells(stack: HeatSceneStack, model) -> tuple[list[dict[str, Any]], float]:
    """Predict scene LST, returning pixel-center points and a relative top-decile flag."""
    x = _feature_frame(stack)
    if x.empty:
        raise HeatModelError("Scene has no valid pixels after QA and AOI masking")
    predictions = np.asarray(model.predict(x), dtype=np.float32)
    if not np.isfinite(predictions).all():
        raise HeatModelError("Model returned non-finite LST values")

    rows, cols = np.nonzero(stack.valid_mask)
    threshold = float(np.percentile(predictions, 90))
    xs, ys = rasterio.transform.xy(stack.transform, rows, cols, offset="center")
    lngs, lats = transform(stack.crs, "EPSG:4326", xs, ys)
    cells = [
        {
            "grid_id": f"{stack.scene_id}:{int(row)}:{int(col)}",
            "grid_row": int(row),
            "grid_col": int(col),
            "lng": float(lng),
            "lat": float(lat),
            "temperature_c": float(value),
            "hotspot": bool(value >= threshold),
        }
        for row, col, lng, lat, value in zip(rows, cols, lngs, lats, predictions)
    ]
    return cells, threshold
