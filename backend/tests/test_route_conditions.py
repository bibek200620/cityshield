import pytest
from shapely.geometry import LineString, box
from shapely.strtree import STRtree

from app.routing import conditions


def test_weather_uses_completed_hours_and_rejects_stale_readings():
    payload = {
        "current": {"time": 7200, "temperature_2m": 25, "apparent_temperature": 27},
        "hourly": {
            "time": [3600, 7200, 10800, 14400, 18000],
            "precipitation": [1, 2, 3, 4, 5],
            "temperature_2m": [24, 25, 26, 27, 28],
            "apparent_temperature": [25, 27, 28, 29, 30],
            "relative_humidity_2m": [60, 61, 62, 63, 64],
        },
    }
    summary = conditions.parse_weather(payload, 7500)
    assert summary["recent_rain_mm"] == 3
    assert summary["upcoming_rain_mm"] == 12
    assert summary["feels_like_c"] == 27
    assert [slot["precipitation_mm"] for slot in summary["hourly_forecast"]] == [3, 4, 5]
    assert summary["hourly_forecast"][2]["air_temperature_c"] == 28
    assert summary["hourly_forecast"][2]["relative_humidity_pct"] == 64
    assert summary["forecast_through"] == conditions.iso_utc(18000)
    with pytest.raises(ValueError, match="stale"):
        conditions.parse_weather(payload, 11000)


def test_weather_rejects_misaligned_or_missing_forecast_hours():
    payload = {
        "current": {"time": 7200, "temperature_2m": 25, "apparent_temperature": 27},
        "hourly": {
            "time": [3600, 7200, 10800, 14400, 18000],
            "precipitation": [1, 2, 3, 4, 5],
            "temperature_2m": [24, 25, 26, 27],
            "apparent_temperature": [25, 27, 28, 29, 30],
            "relative_humidity_2m": [60, 61, 62, 63, 64],
        },
    }
    with pytest.raises(ValueError, match="Misaligned"):
        conditions.parse_weather(payload, 7500)

    payload["hourly"]["temperature_2m"] = [24, 25, 26, 27, 28]
    payload["hourly"]["time"].pop()
    for key in ("precipitation", "temperature_2m", "apparent_temperature", "relative_humidity_2m"):
        payload["hourly"][key].pop()
    with pytest.raises(ValueError, match="Missing"):
        conditions.parse_weather(payload, 7500)


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
