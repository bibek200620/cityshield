"""Train and evaluate a station-only next-day Tmax research baseline.

From ``backend/`` with the GHCNh HAL station archive available:
``.venv/bin/python -m app.heat.train_station_observations --input /path/to/GHCNh_INM00043296_por.psv``.
This workflow does not expose a city heatwave forecast.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from app.heat.station_observations import (
    StationDataError,
    aggregate_local_days,
    build_next_day_dataset,
    load_paired_observations,
)

TRAIN_START = "2005-01-01"
TRAIN_END = "2022-12-31"
TEST_START = "2023-01-01"
TEST_END = "2025-12-31"
RANDOM_SEED = 42
FEATURE_COLUMNS = (
    "previous_tmax_c",
    "previous_tmean_c",
    "previous_tmin_c",
    "previous_rh_mean_pct",
    "previous_rh_max_pct",
    "previous_rh_min_pct",
    "target_doy_sin",
    "target_doy_cos",
)
MODEL_PARAMETERS = {
    "n_estimators": 250,
    "max_depth": 3,
    "learning_rate": 0.04,
    "subsample": 0.8,
    "colsample_bytree": 0.9,
    "reg_lambda": 1.0,
    "objective": "reg:squarederror",
    "random_state": RANDOM_SEED,
    "n_jobs": 1,
    "tree_method": "hist",
}


def score(target: np.ndarray, prediction: np.ndarray) -> dict:
    target = np.asarray(target, dtype=float)
    prediction = np.asarray(prediction, dtype=float)
    if target.shape != prediction.shape or target.size == 0:
        raise StationDataError("Metrics require non-empty targets and predictions with matching shapes")
    if not np.isfinite(target).all() or not np.isfinite(prediction).all():
        raise StationDataError("Metrics require finite targets and predictions")
    error = prediction - target
    return {
        "sample_count": int(target.size),
        "mae_c": float(np.mean(np.abs(error))),
        "rmse_c": float(np.sqrt(np.mean(error**2))),
        "bias_c": float(np.mean(error)),
    }


def seasonal_climatology(
    train_target: np.ndarray,
    train_day_of_year: np.ndarray,
    target_day_of_year: np.ndarray,
    *,
    window_days: int = 15,
) -> np.ndarray:
    """Estimate circular day-of-year means from training targets only."""
    values = np.asarray(train_target, dtype=float)
    train_days = np.asarray(train_day_of_year, dtype=int)
    target_days = np.asarray(target_day_of_year, dtype=int)
    if values.size == 0 or values.shape != train_days.shape or not np.isfinite(values).all():
        raise StationDataError("Seasonal climatology requires finite training targets and dates")
    if ((train_days < 1) | (train_days > 366)).any() or ((target_days < 1) | (target_days > 366)).any():
        raise StationDataError("Day-of-year values must be within 1..366")
    distance = np.abs(target_days[:, None] - train_days[None, :])
    circular_distance = np.minimum(distance, 366 - distance)
    prediction = []
    for row in circular_distance:
        selected = values[row <= window_days]
        if not selected.size:
            raise StationDataError("No training targets fall within the climatology window")
        prediction.append(float(selected.mean()))
    return np.asarray(prediction)


def evaluate_examples(examples: pd.DataFrame, source_metadata: dict, daily_quality: dict, output_dir: Path) -> dict:
    """Fit only pre-2023 rows and compare methods on identical 2023–2025 rows."""
    if not isinstance(examples.index, pd.DatetimeIndex) or examples.index.tz is None:
        raise StationDataError("Example target dates must be timezone-aware")
    if str(examples.index.tz) != "Asia/Kolkata":
        raise StationDataError("Example target dates must use Asia/Kolkata")
    if examples.index.has_duplicates or not examples.index.is_monotonic_increasing:
        raise StationDataError("Example target dates must be unique and chronological")
    required = {*FEATURE_COLUMNS, "target_tmax_c"}
    if not required.issubset(examples.columns):
        raise StationDataError(f"Examples are missing columns: {sorted(required - set(examples.columns))}")
    if not np.isfinite(examples.loc[:, [*FEATURE_COLUMNS, "target_tmax_c"]].to_numpy(dtype=float)).all():
        raise StationDataError("Model examples must contain only finite values")
    train = examples.loc[TRAIN_START:TRAIN_END]
    test = examples.loc[TEST_START:TEST_END]
    if train.empty or test.empty:
        raise StationDataError("Need pre-2023 training targets and 2023–2025 chronological test targets")
    if train.index.max() >= test.index.min():
        raise StationDataError("Chronological training and held-out target dates overlap")

    train_x = train.loc[:, FEATURE_COLUMNS].astype(float)
    test_x = test.loc[:, FEATURE_COLUMNS].astype(float)
    train_y = train["target_tmax_c"].to_numpy(dtype=float)
    test_y = test["target_tmax_c"].to_numpy(dtype=float)
    model = XGBRegressor(**MODEL_PARAMETERS)
    model.fit(train_x, train_y)
    predictions = {
        "xgboost": model.predict(test_x),
        "persistence_previous_day_tmax": test["previous_tmax_c"].to_numpy(dtype=float),
        "training_only_day_of_year_climatology_15_day_window": seasonal_climatology(
            train_y,
            train.index.dayofyear.to_numpy(),
            test.index.dayofyear.to_numpy(),
        ),
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / "ghcnh_hal_next_day_tmax.xgb.json"
    model.save_model(str(model_path))
    report = {
        "status": "observed_station_holdout_evaluated",
        "product_warning": "Single airport-station research results; not a Bengaluru-wide forecast, heatwave warning, or validated advisory.",
        "target": "Next eligible local date's maximum QC-accepted station-reported air temperature (°C)",
        "horizon": "one local calendar day",
        "predictors": "Previous eligible local day's paired temperature/RH summaries plus known target day-of-year sine/cosine",
        "feature_order": list(FEATURE_COLUMNS),
        "source": source_metadata,
        "daily_quality": daily_quality,
        "evaluation_provenance": "Predictions compared with held-out GHCNh station observations at the same airport; not an independent station or city-level test.",
        "split": {
            "strategy": "chronological target-date holdout",
            "training_start": train.index.min().date().isoformat(),
            "training_end": train.index.max().date().isoformat(),
            "test_start": test.index.min().date().isoformat(),
            "test_end": test.index.max().date().isoformat(),
            "training_samples": int(len(train)),
            "test_samples": int(len(test)),
            "training_dates_sha256": hashlib.sha256("\n".join(map(str, train.index.date)).encode()).hexdigest(),
            "test_dates_sha256": hashlib.sha256("\n".join(map(str, test.index.date)).encode()).hexdigest(),
        },
        "random_seed": RANDOM_SEED,
        "model": {
            "library": "xgboost",
            "library_version": __import__("xgboost").__version__,
            "parameters": MODEL_PARAMETERS,
            "artifact": model_path.name,
        },
        "baselines": {
            "persistence": "Previous eligible local day's station-observed Tmax",
            "climatology": "Training target Tmax mean within circular day-of-year ±15 days; training rows only",
        },
        "metrics_on_same_held_out_rows": {
            name: score(test_y, prediction)
            for name, prediction in predictions.items()
        },
        "data_gaps": {
            "eligible_days_without_adjacent_target": int(max(0, daily_quality["eligible_local_days"] - len(examples))),
            "gap_policy": "Missing or ineligible days are not filled or bridged; only adjacent eligible local dates produce examples.",
        },
    }
    (output_dir / "evaluation.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def train_and_evaluate(input_path: Path, output_dir: Path) -> dict:
    observations, source_metadata = load_paired_observations(input_path)
    daily, daily_quality = aggregate_local_days(observations)
    examples = build_next_day_dataset(daily)
    annual_days = daily.groupby(daily.index.year).size()
    daily_quality["eligible_days_by_year"] = {str(int(year)): int(count) for year, count in annual_days.items()}
    daily_quality["consecutive_valid_day_transitions"] = int(len(examples))
    return evaluate_examples(examples, source_metadata, daily_quality, output_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Downloaded NOAA GHCNh HAL station PSV archive")
    parser.add_argument("--output-dir", type=Path, default=Path("data/heat/ghcnh-hal"))
    args = parser.parse_args()
    try:
        report = train_and_evaluate(args.input, args.output_dir)
        print(json.dumps(report["metrics_on_same_held_out_rows"], indent=2, sort_keys=True))
        print(f"Full provenance and split report: {args.output_dir / 'evaluation.json'}")
    except (OSError, StationDataError, ValueError) as exc:
        parser.exit(1, f"GHCNh station research workflow unavailable: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
