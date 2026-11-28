from pydantic import SecretStr
from fastapi.testclient import TestClient
import pytest

from app.api import routes_weather
from app.main import app


def test_point_forecast_uses_configured_backend_forecast_without_source_branding(monkeypatch):
    monkeypatch.setattr(routes_weather.settings, "METEOBLUE_API_KEY", SecretStr("server-secret"))
    monkeypatch.setattr(routes_weather.settings, "GOOGLE_MAPS_API_KEY", None)
    monkeypatch.setattr(routes_weather, "get_meteoblue_forecast", lambda *args: {
        "location": {"latitude": 12.9, "longitude": 77.6},
        "source": "internal test source",
        "retrieved_at": "2026-11-28T00:00:00Z",
        "hours": [],
    })

    response = TestClient(app).get("/api/weather/point-forecast?latitude=12.9&longitude=77.6")

    assert response.status_code == 200
    assert response.json()["location"] == {"latitude": 12.9, "longitude": 77.6}
    assert "source" not in response.json()
    assert "server-secret" not in response.text


def test_point_forecast_falls_back_to_available_48_hour_forecast(monkeypatch):
    monkeypatch.setattr(routes_weather.settings, "METEOBLUE_API_KEY", None)
    monkeypatch.setattr(routes_weather.settings, "GOOGLE_MAPS_API_KEY", None)
    monkeypatch.setattr(routes_weather, "get_two_day_forecast", lambda *args: {
        "status": "ready",
        "provenance": {"retrieved_at": "2026-11-28T00:00:00Z", "model_run": "run-id"},
        "hourly_forecast": [{
            "valid_at": "2026-11-28T01:00:00Z", "air_temperature_c": 29,
            "feels_like_c": 31, "precipitation_mm": 2, "relative_humidity_pct": 65,
        }],
    })

    response = TestClient(app).get("/api/weather/point-forecast?latitude=12.9&longitude=77.6")

    assert response.status_code == 200
    assert response.json()["hours"][0]["air_temperature_c"] == 29
    assert any("48 hourly" in item for item in response.json()["limitations"])
    assert "current" not in response.json()


def test_point_forecast_returns_unavailable_when_fallback_is_unavailable(monkeypatch):
    monkeypatch.setattr(routes_weather.settings, "METEOBLUE_API_KEY", None)
    monkeypatch.setattr(routes_weather.settings, "GOOGLE_MAPS_API_KEY", None)
    monkeypatch.setattr(routes_weather, "get_two_day_forecast", lambda *args: {
        "status": "unavailable", "message": "Try again shortly.",
    })
    response = TestClient(app).get("/api/weather/point-forecast?latitude=12.9&longitude=77.6")
    assert response.status_code == 503
    assert response.json()["detail"] == "Try again shortly."


def test_air_quality_endpoint_uses_point_estimate_and_omits_source_branding(monkeypatch):
    monkeypatch.setattr(routes_weather.settings, "GOOGLE_MAPS_API_KEY", None)
    monkeypatch.setattr(routes_weather, "get_air_quality", lambda *args: {
        "status": "ready", "source": "internal test source", "indexes": [], "pollutants": [],
        "limitations": ["modeled values"],
    })
    response = TestClient(app).get("/api/weather/air-quality?latitude=12.9&longitude=77.6")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert "source" not in response.json()


def test_point_forecast_uses_google_key_when_no_dedicated_forecast_key_is_set(monkeypatch):
    monkeypatch.setattr(routes_weather.settings, "METEOBLUE_API_KEY", None)
    monkeypatch.setattr(routes_weather.settings, "GOOGLE_MAPS_API_KEY", SecretStr("server-secret"))
    calls = []

    def google_forecast(*args):
        calls.append(args)
        return {
            "location": {"latitude": 12.9, "longitude": 77.6},
            "source": "internal test source",
            "retrieved_at": "2026-11-28T00:00:00Z",
            "current": {"air_temperature_c": 28},
            "hours": [],
        }

    monkeypatch.setattr(routes_weather, "get_point_weather", google_forecast)
    monkeypatch.setattr(routes_weather, "get_two_day_forecast", lambda *_args: pytest.fail("unexpected fallback"))

    response = TestClient(app).get("/api/weather/point-forecast?latitude=12.9&longitude=77.6")

    assert response.status_code == 200
    assert response.json()["location"] == {"latitude": 12.9, "longitude": 77.6}
    assert "source" not in response.json()
    assert "server-secret" not in response.text
    assert calls and calls[0][:2] == (12.9, 77.6)


def test_air_quality_uses_google_key_and_falls_back_if_it_is_unavailable(monkeypatch):
    monkeypatch.setattr(routes_weather.settings, "GOOGLE_MAPS_API_KEY", SecretStr("server-secret"))
    monkeypatch.setattr(routes_weather, "get_point_air_quality", lambda *_args: {
        "status": "ready", "source": "internal test source", "indexes": [], "pollutants": [],
        "limitations": ["estimate"],
    })
    google_response = TestClient(app).get("/api/weather/air-quality?latitude=12.9&longitude=77.6")
    assert google_response.status_code == 200
    assert google_response.json()["status"] == "ready"
    assert "source" not in google_response.json()

    from fastapi import HTTPException

    monkeypatch.setattr(routes_weather, "get_point_air_quality", lambda *_args: (_ for _ in ()).throw(
        HTTPException(status_code=502, detail="unavailable")))
    monkeypatch.setattr(routes_weather, "get_air_quality", lambda *_args: {
        "status": "unavailable", "indexes": [], "pollutants": [], "limitations": [],
    })
    fallback_response = TestClient(app).get("/api/weather/air-quality?latitude=12.9&longitude=77.6")
    assert fallback_response.status_code == 200
    assert fallback_response.json()["status"] == "unavailable"
