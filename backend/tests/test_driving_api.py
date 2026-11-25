from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.api import routes_driving
from app.core.config import settings
from app.main import app


REQUEST = {
    "source": {"lat": 12.979, "lng": 77.6408},
    "destination": {"lat": 12.9698, "lng": 77.7499},
}


def test_driving_comparison_merges_an_identical_shortest_path(monkeypatch):
    primary = {"summary": {"length": 10, "time": 800}, "legs": [{"shape": "??AA"}]}
    alternate = {"summary": {"length": 11, "time": 900}, "legs": [{"shape": "??CC"}]}

    def query(req, *, shortest):
        return {"trip": primary} if shortest else {"trip": primary, "alternates": [{"trip": alternate}]}

    monkeypatch.setattr(routes_driving, "query_valhalla", query)
    monkeypatch.setattr(settings, "TOMTOM_API_KEY", None)
    monkeypatch.setattr(routes_driving, "annotate_conditions", lambda routes, key: {})
    response = TestClient(app).post("/api/drive/routes", json=REQUEST)
    assert response.status_code == 200
    result = response.json()
    assert result["shortest_available"]
    assert result["traffic"]["status"] == "unavailable"
    assert [r["labels"] for r in result["routes"]] == [["Best estimated time", "Shortest distance"], ["Alternative"]]
    assert result["routes"][0]["coordinates"] == [[0, 0], [0.000001, 0.000001]]


def test_driving_rejects_points_outside_bengaluru_before_querying_provider(monkeypatch):
    def unexpected_query(*args, **kwargs):
        raise AssertionError("An out-of-area request must be rejected locally")

    monkeypatch.setattr(routes_driving, "query_valhalla", unexpected_query)
    response = TestClient(app).post(
        "/api/drive/routes", json={**REQUEST, "destination": {"lat": 18, "lng": 77}},
    )
    assert response.status_code == 422


def test_configured_traffic_adapter_uses_provider_time_without_hazard_adjustments(monkeypatch):
    def fetch(url, params):
        assert params["traffic"] == "true"
        return {"routes": [{
            "summary": {"travelTimeInSeconds": 900, "noTrafficTravelTimeInSeconds": 600, "lengthInMeters": 8000},
            "legs": [{"points": [
                {"latitude": 12.979, "longitude": 77.6408},
                {"latitude": 12.9698, "longitude": 77.7499},
            ]}],
        }]}

    monkeypatch.setattr(settings, "TOMTOM_API_KEY", SecretStr("test-key"))
    monkeypatch.setattr(routes_driving, "fetch_json", fetch)
    monkeypatch.setattr(routes_driving, "annotate_conditions", lambda routes, key: {})
    response = TestClient(app).post("/api/drive/routes", json=REQUEST)
    assert response.status_code == 200
    result = response.json()
    assert result["traffic"]["status"] == "ready"
    assert result["routes"][0]["eta_seconds"] == 900
    assert result["routes"][0]["traffic_time_delta_seconds"] == 300
