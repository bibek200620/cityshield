from __future__ import annotations

import csv
import json
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest
from xgboost import XGBRegressor

from app.heat import train_station_observations as training
from app.heat.station_observations import (
    DAILY_COLUMNS,
    REQUIRED_COLUMNS,
    SOURCE_STATION_ID,
    STATION_ID,
    StationDataError,
    aggregate_local_days,
    build_next_day_dataset,
    load_paired_observations,
)


def _raw_row(timestamp: datetime, **overrides: str) -> dict[str, str]:
    row = {name: "" for name in REQUIRED_COLUMNS}
    row.update({
        "STATION": STATION_ID,
        "Station_name": "BANGALORE/HINDUSTAN AIRPORT",
        "DATE": timestamp.isoformat(timespec="seconds"),
        "LATITUDE": "12.95",
        "LONGITUDE": "77.6333",
        "temperature": "28",
        "temperature_Quality_Code": "1",
        "temperature_Source_Code": "223",
        "temperature_Source_Station_ID": SOURCE_STATION_ID,
        "relative_humidity": "55",
        "relative_humidity_Measurement_Code": "D",
        "relative_humidity_Quality_Code": "",
        "relative_humidity_Source_Code": "223",
        "relative_humidity_Source_Station_ID": SOURCE_STATION_ID,
    })
    row.update(overrides)
    return row


def _write_archive(path, rows):
    columns = sorted(REQUIRED_COLUMNS)
    with path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=columns, delimiter="|")
        writer.writeheader()
        writer.writerows(rows)


def _three_local_days():
    # UTC 18:30 corresponds to local midnight; 3-hour observations span 21 h.
    start = datetime(2022, 12, 31, 18, 30, tzinfo=timezone.utc)
    return [_raw_row(start + timedelta(hours=3 * i), temperature=str(24 + i % 8)) for i in range(24)]


def test_parser_filters_source_and_quality_and_converts_utc_to_local_days(tmp_path):
    path = tmp_path / "station.psv"
    rows = _three_local_days()
    rows.append(_raw_row(
        datetime(2023, 1, 4, 18, 30, tzinfo=timezone.utc),
        temperature_Quality_Code="2",
    ))
    rows.append(_raw_row(
        datetime(2023, 1, 4, 19, 30, tzinfo=timezone.utc),
        relative_humidity_Quality_Code="f",
    ))
    _write_archive(path, rows)

    observations, metadata = load_paired_observations(path)
    daily, quality = aggregate_local_days(observations)
    examples = build_next_day_dataset(daily)

    assert len(observations) == 24
    assert metadata["raw_rows"] == 26
    assert metadata["row_quality_counts"]["excluded_humidity_quality_f"] == 1
    assert str(observations.index.tz) == "UTC"
    assert list(daily.index.date) == [datetime(2023, 1, day).date() for day in (1, 2, 3)]
    assert quality["eligible_local_days"] == 3
    assert len(examples) == 2
    assert examples.index[0] == pd.Timestamp("2023-01-02", tz="Asia/Kolkata")
    assert examples.loc[examples.index[0], "target_tmax_c"] == daily.iloc[1]["tmax_c"]


@pytest.mark.parametrize(
    "override, message",
    [
        ({"STATION": "INMU0020525"}, "not station"),
        ({"LATITUDE": "13.2"}, "coordinates changed"),
        ({"temperature_Quality_Code": "2"}, "No quality-accepted"),
        ({"relative_humidity": "101"}, r"outside \[0, 100\]"),
        ({"relative_humidity_Quality_Code": "x"}, "unknown RH quality flag"),
    ],
)
def test_parser_rejects_wrong_site_or_invalid_values(tmp_path, override, message):
    path = tmp_path / "station.psv"
    _write_archive(path, [_raw_row(datetime(2023, 1, 1, tzinfo=timezone.utc), **override)])

    with pytest.raises(StationDataError, match=message):
        load_paired_observations(path)


def test_parser_rejects_duplicate_timestamps(tmp_path):
    path = tmp_path / "station.psv"
    timestamp = datetime(2023, 1, 1, tzinfo=timezone.utc)
    _write_archive(path, [_raw_row(timestamp), _raw_row(timestamp)])

    with pytest.raises(StationDataError, match="Duplicate GHCNh timestamp"):
        load_paired_observations(path)


def test_daily_completeness_and_next_day_examples_do_not_bridge_gaps(tmp_path):
    path = tmp_path / "station.psv"
    rows = _three_local_days()
    # Remove the full middle day, so neither side can bridge over it.
    rows = [row for index, row in enumerate(rows) if not 8 <= index < 16]
    _write_archive(path, rows)
    observations, _ = load_paired_observations(path)
    daily, _ = aggregate_local_days(observations)

    assert tuple(daily.columns) == DAILY_COLUMNS
    assert len(daily) == 2
    with pytest.raises(StationDataError, match="No adjacent eligible"):
        build_next_day_dataset(daily)


def test_training_uses_chronological_holdout_and_saves_loadable_model(monkeypatch, tmp_path):
    dates = pd.date_range("2022-01-01", "2023-01-15", freq="D", tz="Asia/Kolkata")
    day = np.arange(len(dates), dtype=float)
    examples = pd.DataFrame(
        {
            "previous_tmax_c": 27 + np.sin(day / 20),
            "previous_tmean_c": 23 + np.sin(day / 20),
            "previous_tmin_c": 18 + np.sin(day / 20),
            "previous_rh_mean_pct": 60 + np.cos(day / 15),
            "previous_rh_max_pct": 75 + np.cos(day / 15),
            "previous_rh_min_pct": 45 + np.cos(day / 15),
            "target_doy_sin": np.sin(2 * np.pi * dates.dayofyear / 365.25),
            "target_doy_cos": np.cos(2 * np.pi * dates.dayofyear / 365.25),
            "target_tmax_c": 28 + np.sin(day / 20),
        },
        index=dates,
    )
    monkeypatch.setattr(training, "MODEL_PARAMETERS", {**training.MODEL_PARAMETERS, "n_estimators": 3})
    report = training.evaluate_examples(
        examples,
        {"provenance_class": "synthetic_test_fixture"},
        {"eligible_local_days": len(dates)},
        tmp_path,
    )

    assert report["split"]["training_end"] == "2022-12-31"
    assert report["split"]["test_start"] == "2023-01-01"
    assert report["split"]["training_samples"] == 365
    assert report["split"]["test_samples"] == 15
    assert {metric["sample_count"] for metric in report["metrics_on_same_held_out_rows"].values()} == {15}
    saved = json.loads((tmp_path / "evaluation.json").read_text())
    model = XGBRegressor()
    model.load_model(str(tmp_path / "ghcnh_hal_next_day_tmax.xgb.json"))
    assert saved["feature_order"] == list(training.FEATURE_COLUMNS)
    assert tuple(model.get_booster().feature_names) == training.FEATURE_COLUMNS


def test_training_rejects_leaky_or_invalid_splits(tmp_path):
    rows = pd.DataFrame(
        {name: [1.0, 2.0] for name in [*training.FEATURE_COLUMNS, "target_tmax_c"]},
        index=pd.DatetimeIndex(["2022-12-31", "2023-01-01"], tz="Asia/Kolkata"),
    )
    with pytest.raises(StationDataError, match="pre-2023 training targets"):
        training.evaluate_examples(rows.iloc[1:], {}, {}, tmp_path)


def test_climatology_uses_only_training_values():
    prediction = training.seasonal_climatology(
        np.array([30.0, 32.0, 100.0]),
        np.array([1, 2, 200]),
        np.array([1]),
        window_days=2,
    )
    assert prediction.tolist() == pytest.approx([31.0])
