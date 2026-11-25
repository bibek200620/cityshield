import json
from datetime import datetime

import numpy as np
import pandas as pd
import pytest
from xgboost import XGBRegressor

from app.heat import train_reanalysis
from app.heat.reanalysis import (
    FEATURE_COLUMNS,
    ReanalysisDataError,
    archive_params,
    build_next_day_dataset,
    daily_weather,
    load_archive,
    validate_archive_payload,
)


def archive_fixture(year=2020, *, missing_temperature_at=None):
    index = pd.date_range(f"{year}-01-01", f"{year + 1}-01-01", inclusive="left", freq="h")
    temperature = (20 + 5 * np.sin(np.arange(len(index)) * 2 * np.pi / 24 / 365)).round(2).tolist()
    humidity = (65 + 10 * np.cos(np.arange(len(index)) * 2 * np.pi / 24 / 365)).round(2).tolist()
    if missing_temperature_at is not None:
        temperature[missing_temperature_at] = None
    return {
        "latitude": 13.0,
        "longitude": 77.600006,
        "elevation": 910.0,
        "timezone": "Asia/Kolkata",
        "utc_offset_seconds": 19800,
        "hourly_units": {"temperature_2m": "°C", "relative_humidity_2m": "%"},
        "hourly": {
            "time": [value.strftime("%Y-%m-%dT%H:%M") for value in index],
            "temperature_2m": temperature,
            "relative_humidity_2m": humidity,
        },
    }


def test_archive_query_explicitly_selects_era5_land_and_units():
    params = archive_params(2024)
    assert params["models"] == "era5_land"
    assert params["hourly"] == "temperature_2m,relative_humidity_2m"
    assert params["temperature_unit"] == "celsius"
    assert params["timezone"] == "Asia/Kolkata"
    assert params["cell_selection"] == "land"


def test_archive_parser_validates_leap_year_and_returns_local_timezone():
    parsed = validate_archive_payload(archive_fixture(2024), 2024)
    assert len(parsed) == 366 * 24
    assert str(parsed.index.tz) == "Asia/Kolkata"
    assert parsed.iloc[0]["temperature_2m_c"] == pytest.approx(20)


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda payload: payload.update(timezone="UTC"), "timezone"),
        (lambda payload: payload["hourly_units"].update(temperature_2m="K"), "units"),
        (lambda payload: payload["hourly"].update(relative_humidity_2m=[]), "aligned"),
        (lambda payload: payload["hourly"]["relative_humidity_2m"].__setitem__(0, 101), "between 0 and 100"),
    ],
)
def test_archive_parser_rejects_incompatible_or_invalid_data(mutate, message):
    payload = archive_fixture(2021)
    mutate(payload)
    with pytest.raises(ReanalysisDataError, match=message):
        validate_archive_payload(payload, 2021)


def test_missing_hour_values_exclude_incomplete_day_and_next_day_does_not_bridge_gap():
    hourly = validate_archive_payload(archive_fixture(2020, missing_temperature_at=24), 2020)
    daily, quality = daily_weather(hourly.iloc[: 24 * 3])
    assert quality["excluded_incomplete_days"] == 1
    assert list(daily.index.day) == [1, 3]
    with pytest.raises(ReanalysisDataError, match="No adjacent complete local days"):
        build_next_day_dataset(daily)


def test_features_use_previous_complete_day_and_target_date():
    hourly = validate_archive_payload(archive_fixture(2020), 2020)
    daily, _ = daily_weather(hourly.iloc[: 24 * 4])
    examples = build_next_day_dataset(daily)
    row = examples.loc[pd.Timestamp("2020-01-02", tz="Asia/Kolkata")]
    assert tuple(column for column in examples.columns if column in FEATURE_COLUMNS) == FEATURE_COLUMNS
    assert row["previous_tmax_c"] == pytest.approx(daily.loc[pd.Timestamp("2020-01-01", tz="Asia/Kolkata"), "tmax_c"])
    assert row["target_tmax_c"] == pytest.approx(daily.loc[pd.Timestamp("2020-01-02", tz="Asia/Kolkata"), "tmax_c"])


def test_load_archive_rejects_grid_cell_mismatch(tmp_path):
    for year, longitude in ((2020, 77.6), (2021, 77.7)):
        payload = archive_fixture(year)
        payload["longitude"] = longitude
        cached = {
            "request": archive_params(year),
            "retrieved_at_utc": "2026-11-26T00:00:00+00:00",
            "response": payload,
        }
        (tmp_path / f"era5-land-{year}.json").write_text(json.dumps(cached))
    with pytest.raises(ReanalysisDataError, match="consistent grid cell"):
        load_archive(list(tmp_path.glob("*.json")))


def test_load_archive_rejects_missing_or_wrong_request_manifest(tmp_path):
    payload = archive_fixture(2020)
    (tmp_path / "era5-land-2020.json").write_text(json.dumps({"response": payload}))
    with pytest.raises(ReanalysisDataError, match="request manifest"):
        load_archive([tmp_path / "era5-land-2020.json"])


def test_load_archive_requires_utc_retrieval_timestamp(tmp_path):
    cached = {
        "request": archive_params(2020),
        "retrieved_at_utc": "2026-11-26T00:00:00",
        "response": archive_fixture(2020),
    }
    path = tmp_path / "era5-land-2020.json"
    path.write_text(json.dumps(cached))
    with pytest.raises(ReanalysisDataError, match="must be UTC"):
        load_archive([path])


def test_training_artifacts_compare_same_chronological_reanalysis_rows(monkeypatch, tmp_path):
    hourly_index = pd.date_range("1999-12-01", "2000-02-01", inclusive="left", freq="h", tz="Asia/Kolkata")
    hour = np.arange(len(hourly_index))
    hourly = pd.DataFrame(
        {
            "temperature_2m_c": 22 + 4 * np.sin(hour * 2 * np.pi / 24 / 7),
            "relative_humidity_2m_pct": 60 + 15 * np.cos(hour * 2 * np.pi / 24 / 7),
        },
        index=hourly_index,
    )
    monkeypatch.setattr(train_reanalysis, "TRAIN_END", "2000-01-24")
    monkeypatch.setattr(train_reanalysis, "TRAIN_START", "2000-01-01")
    monkeypatch.setattr(train_reanalysis, "TEST_START", "2000-01-25")
    monkeypatch.setattr(train_reanalysis, "TEST_END", "2000-01-31")
    monkeypatch.setattr(train_reanalysis, "REQUIRED_ARCHIVE_YEARS", (1999, 2000))
    monkeypatch.setattr(train_reanalysis, "MODEL_PARAMETERS", {**train_reanalysis.MODEL_PARAMETERS, "n_estimators": 3})
    monkeypatch.setattr(
        train_reanalysis,
        "load_archive",
        lambda _paths: (
            hourly,
            {
                "source": "test fixture",
                "provenance_class": "synthetic_test_fixture",
                "model": "era5_land",
                "license": "CC BY 4.0",
                "years": [1999, 2000],
                "start_year": 1999,
                "end_year": 2000,
            },
        ),
    )
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    for year in (1999, 2000):
        (raw_dir / f"era5-land-{year}.json").write_text(f'{{"fixture_year":{year}}}')

    report = train_reanalysis.train_and_evaluate(raw_dir, tmp_path / "model")

    methods = report["metrics_on_same_held_out_rows"]
    counts = {metrics["sample_count"] for metrics in methods.values()}
    assert len(counts) == 1
    assert report["split"]["training_end"] < report["split"]["test_start"]
    assert report["split"]["training_start"] >= "2000-01-01"
    assert report["evaluation_provenance"].startswith("Chronological holdout against ERA5-Land")
    assert "operational forecast" in report["product_warning"]
    assert (tmp_path / "model" / "evaluation.json").is_file()
    model = XGBRegressor()
    model.load_model(tmp_path / "model" / "era5_land_next_day_tmax.xgb.json")
    assert len(model.get_booster().feature_names) == len(FEATURE_COLUMNS)


def test_seasonal_climatology_is_derived_from_training_values_only():
    prediction = train_reanalysis.seasonal_climatology(
        np.array([30.0, 32.0, 90.0]),
        np.array([1, 2, 200]),
        np.array([1]),
        window_days=2,
    )
    assert prediction.tolist() == pytest.approx([31.0])
