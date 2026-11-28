import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes_backtest import router
from app.core.config import settings
from app.ml.storm_evaluation import rainfall_fingerprint
from app.ml.storm_import import load_storm_bundle


def readings(day, values, hour=10):
    return [{"at": f"2020-10-{day}T{hour}:{minute}:00+05:30", "value": value, "qc": "valid"}
            for minute, value in zip((15, 30, 45), values, strict=True)]


def bundle(day, event_id, partition, *, public=True):
    metadata = {"lat": 12.9, "lng": 77.6, "location_reference": "Test survey"}
    return {
        "schema_version": "1.0", "event_id": event_id, "storm_group_id": event_id,
        "catchment_id": "example", "partition": partition, "partition_reference": "Test split",
        "time_zone": "Asia/Kolkata", "start_at": f"2020-10-{day}T10:00:00+05:30",
        "end_at": f"2020-10-{day}T10:45:00+05:30", "interval_minutes": 15,
        "source": {"title": "Test instruments", "url": "https://example.org/obs", "reference": "Fixture",
                   "reuse_terms": "Test only", "allow_api_display": public},
        "network": {"id": "net", "version": "v1", "basis": "surveyed", "source": "Survey", "reference": "Test"},
        "gauges": [{**metadata, "id": "rain-a", "unit": "mm/h", "readings": readings(day, [0, 12, 4])}],
        "sensors": [{**metadata, "id": "depth-a", "node_id": "node-a", "gauge_id": "rain-a",
                     "mapping_reference": "Test crosswalk", "invert_elevation_m": 800, "vertical_datum": "Datum A",
                     "unit": "cm", "measurement_reference": "drain_invert", "readings": readings(day, [10, 60, 20])}],
    }


def write_json(path: Path, value) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "STORM_EVENT_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(router)
    write_json(tmp_path / "development.json", bundle("01", "development", "development", public=False))
    path = write_json(tmp_path / "holdout.json", bundle("20", "holdout", "holdout"))
    imported = load_storm_bundle(path)
    assert imported.event, imported.report
    run = {
        "schema_version": "1.0.0", "event_id": "holdout", "catchment_id": "example", "network_id": "net",
        "network_version": "v1", "quantity": "drain_depth_above_invert_m", "name": "Fixture drainage run",
        "version": "1", "run_reference": "Fixture run", "source_url": "https://example.org/run",
        "reuse_terms": "Test only", "allow_api_display": True, "rainfall_sha256": rainfall_fingerprint(imported.event),
        "calibration_storm_groups": ["development"],
        "nodes": {"node-a": {"invert_elevation_m": 800, "vertical_datum": "Datum A", "series": [
            {"timestamp": "2020-10-20T04:45:00Z", "depth_m": 0.1},
            {"timestamp": "2020-10-20T05:00:00Z", "depth_m": 0.5},
            {"timestamp": "2020-10-20T05:15:00Z", "depth_m": 0.7},
        ]}},
    }
    return TestClient(app), tmp_path, run


def test_readiness_and_metrics_with_utc_alignment(catalog):
    client, directory, run = catalog
    assert client.get("/api/backtest/holdout").status_code == 501
    assert client.get("/api/backtest/development").status_code == 501
    write_json(directory / "model_runs/holdout.json", run)
    assert client.get("/api/backtest").json() == {"events": [{
        "event_id": "holdout", "catchment_id": "example", "partition": "holdout", "status": "ready", "message": None,
    }]}
    response = client.get("/api/backtest/holdout")
    assert response.status_code == 200
    data = response.json()
    assert data["observation_source"]["title"] == "Test instruments"
    sensor = data["sensors"][0]
    assert [row["rainfall_mm"] for row in sensor["series"]] == [0, 3, 1]
    assert sensor["metrics"]["mae_m"] == pytest.approx(0.2)
    assert sensor["metrics"]["peak_timing_error_minutes"] == 15


@pytest.mark.parametrize("issue", ["datum", "forcing", "leakage", "overlap", "time", "private"])
def test_unusable_model_does_not_return_metrics(catalog, issue):
    client, directory, run = catalog
    if issue == "datum":
        run["nodes"]["node-a"]["vertical_datum"] = "Datum B"
    if issue == "forcing":
        run["rainfall_sha256"] = "0" * 64
    if issue == "leakage":
        run["calibration_storm_groups"].append("holdout")
    if issue == "overlap":
        overlap = bundle("20", "overlap", "development", public=False)
        overlap["storm_group_id"] = "development"
        write_json(directory / "overlap.json", overlap)
    if issue == "time":
        run["nodes"]["node-a"]["series"].append({"timestamp": "2020-10-20T05:05:00Z", "depth_m": 0.6})
    if issue == "private":
        run["allow_api_display"] = False
    write_json(directory / "model_runs/holdout.json", run)
    response = client.get("/api/backtest/holdout")
    assert response.status_code == (501 if issue == "private" else 422)
    assert set(response.json()) == {"message"}


def test_import_rejects_missing_qc_and_utc_duplicate(tmp_path):
    observations = bundle("20", "broken", "development")
    rain = observations["gauges"][0]["readings"]
    rain[1]["qc"] = "suspect"
    rain.append({"at": "2020-10-20T04:45:00Z", "value": 1, "qc": "valid"})
    imported = load_storm_bundle(write_json(tmp_path / "broken.json", observations))
    assert imported.event is None
    assert {issue["code"] for issue in imported.report["errors"]} == {"duplicate_timestamp", "missing_interval_ends"}
