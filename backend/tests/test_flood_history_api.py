from fastapi.testclient import TestClient

from app.api import routes_flood_history
from app.main import app


def test_historical_flood_records_are_browsable_without_invented_coordinates():
    routes_flood_history._records.cache_clear()
    response = TestClient(app).get("/api/flood/events")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert len(body["events"]) == 53
    assert body["location_precision"] == "district"
    assert all(event["has_coordinates"] is False for event in body["events"])
    assert all(event["evaluation_eligible"] is False for event in body["events"])
    assert any(event["multi_district_event"] for event in body["events"])
    assert body["citation"]["license"] == "CC BY 4.0"
    assert any("map location" in item for item in body["limitations"])


def test_missing_historical_inventory_is_unavailable_not_empty_success(monkeypatch):
    routes_flood_history._records.cache_clear()
    monkeypatch.setattr(routes_flood_history, "EVENTS_PATH", routes_flood_history.EVENTS_PATH.parent / "missing.csv")
    routes_flood_history._records.cache_clear()

    response = TestClient(app).get("/api/flood/events")
    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert response.json()["events"] == []
