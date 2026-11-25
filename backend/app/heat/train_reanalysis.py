"""Train a next-day ERA5-Land Tmax research baseline, not a heatwave warning.

From backend/: ``python -m app.heat.train_reanalysis --download --train``.
Raw archives and model/evaluation outputs are written under ignored ``data/``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from app.heat.reanalysis import (
    FEATURE_COLUMNS,
    REQUIRED_ARCHIVE_YEARS,
    ReanalysisDataError,
    build_next_day_dataset,
    daily_weather,
    download_archive,
    load_archive,
)

TRAIN_START = "2000-01-01"
TRAIN_END = "2020-12-31"
TEST_START = "2021-01-01"
TEST_END = "2025-12-31"
RANDOM_SEED = 42
MODEL_PARAMETERS = {
    "n_estimators": 300,
    "max_depth": 4,
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
        raise ReanalysisDataError("Metrics require non-empty targets and predictions with matching shapes")
    if not np.isfinite(target).all() or not np.isfinite(prediction).all():
        raise ReanalysisDataError("Metrics require finite targets and predictions")
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
    """Use training targets only to estimate a circular day-of-year mean."""
    values = np.asarray(train_target, dtype=float)
    train_days = np.asarray(train_day_of_year, dtype=int)
    target_days = np.asarray(target_day_of_year, dtype=int)
    if values.size == 0 or values.shape != train_days.shape or not np.isfinite(values).all():
        raise ReanalysisDataError("Seasonal climatology requires finite training targets and day-of-year values")
    if ((train_days < 1) | (train_days > 366)).any() or ((target_days < 1) | (target_days > 366)).any():
        raise ReanalysisDataError("Day-of-year values must be within 1..366")
    distances = np.abs(target_days[:, None] - train_days[None, :])
    circular_distances = np.minimum(distances, 366 - distances)
    predictions = []
    for row in circular_distances:
        selected = values[row <= window_days]
        if selected.size == 0:
            raise ReanalysisDataError("No training targets fall inside the climatology window")
        predictions.append(float(selected.mean()))
    return np.asarray(predictions)


def train_and_evaluate(data_dir: Path, output_dir: Path) -> dict:
    annual_files = sorted(data_dir.glob("era5-land-*.json"))
    if not annual_files:
        raise ReanalysisDataError(f"No validated ERA5-Land annual files found under {data_dir}")
    hourly, source_metadata = load_archive(annual_files)
    archive_years = set(source_metadata["years"])
    if not set(REQUIRED_ARCHIVE_YEARS) <= archive_years:
        missing = sorted(set(REQUIRED_ARCHIVE_YEARS) - archive_years)
        raise ReanalysisDataError(f"Training/evaluation requires all archive years 1999–2025; missing {missing}")
    daily, quality = daily_weather(hourly)
    examples = build_next_day_dataset(daily)
    train = examples.loc[TRAIN_START:TRAIN_END]
    test = examples.loc[TEST_START:TEST_END]
    if train.empty or test.empty:
        raise ReanalysisDataError(
            f"Data must cover training through {TRAIN_END} and held-out evaluation {TEST_START}..{TEST_END}"
        )
    if train.index.max() >= test.index.min():
        raise ReanalysisDataError("Chronological train and test dates overlap")

    train_x = train.loc[:, FEATURE_COLUMNS].astype(float)
    test_x = test.loc[:, FEATURE_COLUMNS].astype(float)
    train_y = train["target_tmax_c"].to_numpy(dtype=float)
    test_y = test["target_tmax_c"].to_numpy(dtype=float)
    model = XGBRegressor(**MODEL_PARAMETERS)
    model.fit(train_x, train_y)

    persistence = test["previous_tmax_c"].to_numpy(dtype=float)
    climatology = seasonal_climatology(
        train_y,
        train.index.dayofyear.to_numpy(),
        test.index.dayofyear.to_numpy(),
    )
    predictions = {
        "xgboost": model.predict(test_x),
        "persistence_previous_day_tmax": persistence,
        "training_only_day_of_year_climatology_15_day_window": climatology,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / "era5_land_next_day_tmax.xgb.json"
    model.save_model(str(model_path))
    fingerprint = hashlib.sha256()
    for path in annual_files:
        fingerprint.update(path.name.encode())
        fingerprint.update(path.read_bytes())

    report = {
        "status": "research_baseline_evaluated",
        "product_warning": "This is not an operational forecast, an official heatwave warning, or validation against station observations.",
        "target": "Next local calendar day's ERA5-Land 2 m maximum air temperature (°C)",
        "horizon": "one local calendar day",
        "predictors": "Previous local day's complete hourly 2 m temperature/RH summaries plus known target day-of-year sine/cosine",
        "feature_order": list(FEATURE_COLUMNS),
        "source": source_metadata,
        "dataset_sha256": fingerprint.hexdigest(),
        "data_quality": quality,
        "evaluation_provenance": "Chronological holdout against ERA5-Land reanalysis-derived targets; not independent station observations.",
        "split": {
            "strategy": "chronological target-date holdout",
            "training_start": train.index.min().date().isoformat(),
            "training_end": train.index.max().date().isoformat(),
            "test_start": test.index.min().date().isoformat(),
            "test_end": test.index.max().date().isoformat(),
            "training_samples": int(len(train)),
            "test_samples": int(len(test)),
        },
        "random_seed": RANDOM_SEED,
        "model": {
            "library": "xgboost",
            "library_version": __import__("xgboost").__version__,
            "parameters": MODEL_PARAMETERS,
            "artifact": model_path.name,
        },
        "baselines": {
            "persistence": "Previous local day's ERA5-Land Tmax",
            "climatology": "Mean training target Tmax within circular day-of-year ±15 days; training rows only",
        },
        "metrics_on_same_held_out_rows": {
            name: score(test_y, prediction)
            for name, prediction in predictions.items()
        },
        "dates": {
            "training_target_dates_sha256": hashlib.sha256("\n".join(map(str, train.index.date)).encode()).hexdigest(),
            "test_target_dates_sha256": hashlib.sha256("\n".join(map(str, test.index.date)).encode()).hexdigest(),
        },
    }
    report_path = output_dir / "evaluation.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Fetch missing annual ERA5-Land archive data")
    parser.add_argument("--train", action="store_true", help="Train/evaluate from cached annual archive data")
    parser.add_argument("--start-year", type=int, default=1999, help="First archive year (default: 1999)")
    parser.add_argument("--end-year", type=int, default=2025, help="Last archive year (default: 2025)")
    parser.add_argument("--output-dir", type=Path, default=Path("data/heat/reanalysis"))
    args = parser.parse_args()
    if not args.download and not args.train:
        parser.error("select --download, --train, or both")

    try:
        raw_dir = args.output_dir / "raw"
        if args.download:
            download_archive(raw_dir, start_year=args.start_year, end_year=args.end_year)
        if args.train:
            report = train_and_evaluate(raw_dir, args.output_dir / "model")
            print(json.dumps(report["metrics_on_same_held_out_rows"], indent=2, sort_keys=True))
            print(f"Full provenance and split report: {args.output_dir / 'model' / 'evaluation.json'}")
    except (OSError, ReanalysisDataError, ValueError) as exc:
        parser.exit(1, f"ERA5-Land research workflow unavailable: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
