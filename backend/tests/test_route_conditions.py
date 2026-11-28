import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
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


def make_two_day_weather_payload():
    payload = make_weather_payload()
    times = list(range(3600, 180001, 3600))
    payload["hourly"] = {
        "time": times,
        "precipitation": [float(index % 5) for index in range(len(times))],
        "temperature_2m": [25.0 + index / 10 for index in range(len(times))],
        "apparent_temperature": [26.0 + index / 10 for index in range(len(times))],
        "relative_humidity_2m": [60.0 + index % 30 for index in range(len(times))],
    }
    return payload


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
    assert "api_version" not in provenance
    assert "model_selection" not in provenance
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


def test_weather_conditions_follow_timestamps_and_allow_missing_optional_fields():
    payload = make_weather_payload()
    payload["current"].update(weather_code=3, is_day=1)
    payload["hourly"]["weather_code"] = [3, 3, 61, 71, None]
    payload["hourly"]["is_day"] = [1, 1, 1, 0, False]

    result = conditions.parse_weather(payload, 7500)

    assert (result["weather_code"], result["is_day"]) == (3, 1)
    assert [hour["weather_code"] for hour in result["hourly_forecast"]] == [61, 71, None]
    assert [hour["is_day"] for hour in result["hourly_forecast"]] == [1, 0, None]

    payload["hourly"]["weather_code"].pop()
    result = conditions.parse_weather(payload, 7500)
    assert result["status"] == "ready"
    assert all(hour["weather_code"] is None for hour in result["hourly_forecast"])


def test_two_day_forecast_returns_only_complete_next_48_provider_hours():
    payload = make_two_day_weather_payload()
    result = conditions.parse_two_day_forecast(payload, 7500, "1970-01-01T02:03:00+00:00")

    assert result["status"] == "ready"
    assert result["forecast_hours"] == 48
    assert result["forecast_from"] == conditions.iso_utc(10800)
    assert result["forecast_through"] == conditions.iso_utc(180000)
    assert len(result["hourly_forecast"]) == 48
    assert result["hourly_forecast"][0]["air_temperature_c"] == 25.2
    assert "provider" not in result["provenance"]
    assert result["provenance"]["retrieved_at"] == "1970-01-01T02:03:00+00:00"


def test_two_day_forecast_rejects_missing_late_hour_and_invalid_late_values():
    payload = make_two_day_weather_payload()
    for key in ("time", "precipitation", "temperature_2m", "apparent_temperature", "relative_humidity_2m"):
        payload["hourly"][key].pop()
    with pytest.raises(ValueError, match="complete 48-hour"):
        conditions.parse_two_day_forecast(payload, 7500)

    payload = make_two_day_weather_payload()
    payload["hourly"]["relative_humidity_2m"][-1] = 120
    with pytest.raises(ValueError, match="humidity"):
        conditions.parse_two_day_forecast(payload, 7500)


def test_two_day_weather_api_returns_unavailable_without_provider_data(monkeypatch):
    monkeypatch.setattr(conditions.settings, "METEOBLUE_API_KEY", None)
    monkeypatch.setattr(conditions, "time", lambda: 7500)
    monkeypatch.setattr(conditions, "weather_report_snapshot", lambda *_args: (_ for _ in ()).throw(TimeoutError()))

    with TestClient(app) as client:
        response = client.get("/api/weather/report")

    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert response.json()["reason"] == "timeout"

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
    monkeypatch.setattr(conditions.settings, "METEOBLUE_API_KEY", None)
    monkeypatch.setattr(conditions, "time", lambda: 7500)
    if failure == "timeout":
        def timeout(*_args):
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
        monkeypatch.setattr(conditions, "weather_snapshot", lambda *_args: {
            "payload": payload,
            "retrieved_at": "1970-01-01T02:05:00+00:00",
            "location": {"latitude": 12.98, "longitude": 77.59},
        })

    response = conditions.get_weather()

    assert response["status"] == "unavailable"
    assert response["reason"] == expected_reason
    assert response["checked_at"] == conditions.iso_utc(7500)


def test_weather_api_reports_timeout_without_making_a_network_request(monkeypatch):
    monkeypatch.setattr(conditions.settings, "METEOBLUE_API_KEY", None)
    monkeypatch.setattr(conditions, "time", lambda: 7500)

    def timeout(*_args):
        raise TimeoutError()

    monkeypatch.setattr(conditions, "weather_snapshot", timeout)
    with TestClient(app) as client:
        response = client.get("/api/weather/nowcast")

    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
    assert response.json()["reason"] == "timeout"


def test_meteoblue_fills_nowcast_report_and_city_watch_when_primary_is_down(monkeypatch):
    from urllib.error import URLError

    monkeypatch.setattr(conditions, "time", lambda: 7500)
    monkeypatch.setattr(conditions.settings, "METEOBLUE_API_KEY", SecretStr("fixture"))

    def unavailable(*_args):
        raise URLError("primary provider unavailable")

    for name in ("weather_snapshot", "weather_report_snapshot", "city_watch_snapshot"):
        monkeypatch.setattr(conditions, name, unavailable)

    rows = [
        {"valid_at": conditions.iso_utc(hour * 3600), "precipitation_mm": hour, "air_temperature_c": 25,
         "feels_like_c": 26, "relative_humidity_pct": 65}
        for hour in range(1, 51)
    ]
    point = {"location": {"latitude": 12.98, "longitude": 77.59}, "hours": rows,
             "retrieved_at": conditions.iso_utc(7500)}
    monkeypatch.setattr(conditions, "get_meteoblue_forecast", lambda *_args: point)

    nowcast = conditions.get_weather()
    assert nowcast["status"] == "ready"
    assert nowcast["recent_rain_mm"] == 3
    assert nowcast["upcoming_rain_mm"] == 12
    assert conditions.get_alert_weather() == [nowcast]
    report = conditions.get_two_day_forecast()
    assert report["forecast_hours"] == 48
    assert report["forecast_from"] == conditions.iso_utc(10800)
    assert report["forecast_through"] == conditions.iso_utc(180000)

    rows.pop(0)
    assert conditions.get_weather()["status"] == "unavailable"
    assert conditions.get_two_day_forecast()["forecast_hours"] == 48


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
