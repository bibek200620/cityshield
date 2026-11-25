import pytest
from fastapi.testclient import TestClient
from shapely.geometry import LineString, box
from shapely.strtree import STRtree

from app.routing import conditions
from app.main import app


def make_weather_payload():
    return {
        "latitude": 12.98,
        "longitude": 77.59,
        "elevation": 900.0,
        "timezone": "UTC",
        "timezone_abbreviation": "GMT",
        "utc_offset_seconds": 0,
        "current_units": {"temperature_2m": "°C", "apparent_temperature": "°C"},
        "hourly_units": {
            "precipitation": "mm",
            "temperature_2m": "°C",
            "apparent_temperature": "°C",
            "relative_humidity_2m": "%",
        },
        "current": {"time": 7200, "temperature_2m": 25, "apparent_temperature": 27},
        "hourly": {
            "time": [3600, 7200, 10800, 14400, 18000],
            "precipitation": [1, 2, 3, 4, 5],
            "temperature_2m": [24, 25, 26, 27, 28],
            "apparent_temperature": [25, 27, 28, 29, 30],
            "relative_humidity_2m": [60, 61, 62, 63, 64],
        },
    }


def test_weather_uses_completed_hours_and_rejects_stale_readings():
    payload = make_weather_payload()
    summary = conditions.parse_weather(payload, 7500, "1970-01-01T02:03:00+00:00")
    assert summary["recent_rain_mm"] == 3
    assert summary["upcoming_rain_mm"] == 12
    assert summary["feels_like_c"] == 27
    assert [slot["precipitation_mm"] for slot in summary["hourly_forecast"]] == [3, 4, 5]
    assert summary["hourly_forecast"][2]["air_temperature_c"] == 28
    assert summary["hourly_forecast"][2]["relative_humidity_pct"] == 64
    assert summary["forecast_through"] == conditions.iso_utc(18000)
    provenance = summary["provenance"]
    assert provenance["api_version"] == "v1"
    assert provenance["model_selection"] == "provider default Best Match (automatic)"
    assert provenance["requested_location"] == {"latitude": 12.98, "longitude": 77.59}
    assert provenance["grid_cell_center"]["elevation_m"] == 900
    assert provenance["spatial_resolution_m"] is None
    assert provenance["timezone"] == "UTC"
    assert provenance["units"] == {
        "air_temperature": "°C",
        "apparent_temperature": "°C",
        "relative_humidity": "%",
        "precipitation": "mm",
    }
    assert provenance["retrieved_at"] == "1970-01-01T02:03:00+00:00"
    assert summary["hourly_forecast"][0]["valid_at"] == conditions.iso_utc(10800)
    with pytest.raises(ValueError, match="stale"):
        conditions.parse_weather(payload, 11000)


def test_weather_rejects_misaligned_or_missing_forecast_hours():
    payload = make_weather_payload()
    payload["hourly"]["temperature_2m"].pop()
    with pytest.raises(ValueError, match="misaligned"):
        conditions.parse_weather(payload, 7500)

    payload = make_weather_payload()
    payload["hourly"]["time"].pop()
    for key in ("precipitation", "temperature_2m", "apparent_temperature", "relative_humidity_2m"):
        payload["hourly"][key].pop()
    with pytest.raises(ValueError, match="missing"):
        conditions.parse_weather(payload, 7500)


@pytest.mark.parametrize(
    ("failure", "expected_reason"),
    [
        ("timeout", "timeout"),
        ("missing", "missing_data"),
        ("stale", "stale_data"),
        ("invalid", "invalid_data"),
    ],
)
def test_weather_provider_failures_have_distinct_states(monkeypatch, failure, expected_reason):
    monkeypatch.setattr(conditions, "time", lambda: 7500)
    if failure == "timeout":
        def timeout(_slot):
            raise TimeoutError()
        monkeypatch.setattr(conditions, "weather_snapshot", timeout)
    else:
        payload = make_weather_payload()
        if failure == "missing":
            payload["hourly"].pop("relative_humidity_2m")
        elif failure == "stale":
            payload["current"]["time"] = 1000
        elif failure == "invalid":
            payload["hourly_units"]["precipitation"] = "inch"
        monkeypatch.setattr(conditions, "weather_snapshot", lambda _slot: {
            "payload": payload,
            "retrieved_at": "1970-01-01T02:05:00+00:00",
        })

    response = conditions.get_weather()

    assert response["status"] == "unavailable"
    assert response["reason"] == expected_reason
    assert response["checked_at"] == conditions.iso_utc(7500)


def test_weather_api_reports_timeout_without_making_a_network_request(monkeypatch):
    monkeypatch.setattr(conditions, "time", lambda: 7500)

    def timeout(_slot):
        raise TimeoutError()

    monkeypatch.setattr(conditions, "weather_snapshot", timeout)
    with TestClient(app) as client:
        response = client.get("/api/weather/nowcast")

    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert response.json()["reason"] == "timeout"


def test_projected_rain_changes_runoff_exposure_not_route_eta(monkeypatch):
    cells = [box(0, 0, 300, 300), box(300, 0, 600, 300)]
    monkeypatch.setattr(conditions, "projected_grid", lambda: ({}, cells, STRtree(cells)))
    monkeypatch.setattr(conditions, "screen_values", lambda grid, rain: [rain / 10, 0])
    routes = [{"labels": [], "eta_seconds": 123}]
    lines = [LineString([(0, 150), (600, 150)])]
    weather = {"status": "ready", "recent_rain_mm": 2, "upcoming_rain_mm": 15}
    assert conditions.annotate_runoff(routes, lines, weather)
    assert routes[0]["runoff"] == {"covered_km": 0.6, "current_km": 0.0, "forecast_km": 0.3}
    assert routes[0]["eta_seconds"] == 123
