"""Weather and flood context for Bengaluru road routes."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from functools import lru_cache
from math import isfinite
from time import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pyproj import Transformer
from shapely import get_parts
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.ops import transform, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

from app.api.routes_city_flood import load_grid, screen_values

WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
INCIDENT_URL = "https://api.tomtom.com/traffic/services/5/incidentDetails"
SOURCE = "Open-Meteo weather model"
WEATHER_LOCATION = {"latitude": 12.98, "longitude": 77.59}
WEATHER_UNITS = {
    "air_temperature": "°C",
    "apparent_temperature": "°C",
    "relative_humidity": "%",
    "precipitation": "mm",
}
RUNOFF_THRESHOLD_MM = 1.0
INCIDENT_PROXIMITY_M = 35
PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True).transform
PROVIDER_ERRORS = (URLError, TimeoutError, KeyError, TypeError, ValueError, IndexError)


class WeatherDataError(ValueError):
    """A provider response that is stale, incomplete or invalid."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def fetch_json(url: str, params: dict, *, body: dict | None = None) -> dict:
    headers = {"User-Agent": "CityShield/0.1 (local research)"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    request = Request(url + "?" + urlencode(params), headers=headers, data=data)
    with urlopen(request, timeout=6) as response:
        return json.load(response)


def iso_utc(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _optional_weather_int(value: object, allowed: range) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value in allowed:
        return int(value)
    return None


def parse_weather(payload: dict, now: float, retrieved_at: str | None = None) -> dict:
    """Validate Open-Meteo units, timestamps and spatial provenance before use."""
    if not isinstance(payload, dict):
        raise WeatherDataError("invalid_data", "Weather response must be an object")
    current = payload.get("current")
    hourly = payload.get("hourly")
    if not isinstance(current, dict) or not isinstance(hourly, dict):
        raise WeatherDataError("missing_data", "Current and hourly weather values are required")

    try:
        valid_at = int(current["time"])
    except (KeyError, TypeError, ValueError) as exc:
        raise WeatherDataError("missing_data", "Current valid time is missing") from exc
    if not -900 <= now - valid_at <= 3600:
        raise WeatherDataError("stale_data", "Current weather is stale or too far in the future")

    try:
        grid_latitude = float(payload["latitude"])
        grid_longitude = float(payload["longitude"])
        elevation_m = float(payload["elevation"])
        timezone_name = payload["timezone"]
        utc_offset_seconds = int(payload["utc_offset_seconds"])
        current_units = payload["current_units"]
        hourly_units = payload["hourly_units"]
    except (KeyError, TypeError, ValueError) as exc:
        raise WeatherDataError("missing_data", "Weather provenance or units are missing") from exc
    if (
        not all(isfinite(value) for value in (grid_latitude, grid_longitude, elevation_m))
        or not -90 <= grid_latitude <= 90
        or not -180 <= grid_longitude <= 180
        or not isinstance(timezone_name, str)
        or not timezone_name
        or not isinstance(current_units, dict)
        or not isinstance(hourly_units, dict)
    ):
        raise WeatherDataError("invalid_data", "Weather location or time-zone metadata is invalid")

    expected_units = {
        "current": {"temperature_2m": WEATHER_UNITS["air_temperature"], "apparent_temperature": WEATHER_UNITS["apparent_temperature"]},
        "hourly": {
            "temperature_2m": WEATHER_UNITS["air_temperature"],
            "apparent_temperature": WEATHER_UNITS["apparent_temperature"],
            "relative_humidity_2m": WEATHER_UNITS["relative_humidity"],
            "precipitation": WEATHER_UNITS["precipitation"],
        },
    }
    if any(current_units.get(key) != unit for key, unit in expected_units["current"].items()) or any(
        hourly_units.get(key) != unit for key, unit in expected_units["hourly"].items()
    ):
        raise WeatherDataError("invalid_data", "Provider weather units do not match the requested units")

    fields = ("precipitation", "temperature_2m", "apparent_temperature", "relative_humidity_2m")
    times = hourly.get("time")
    if not isinstance(times, list) or any(not isinstance(hourly.get(key), list) for key in fields):
        raise WeatherDataError("missing_data", "Hourly weather series are missing")
    if any(len(times) != len(hourly[key]) for key in fields):
        raise WeatherDataError("missing_data", "Hourly weather series are misaligned")
    try:
        indexed_times = [int(timestamp) for timestamp in times]
        values = {key: dict(zip(indexed_times, hourly[key])) for key in fields}
    except (TypeError, ValueError) as exc:
        raise WeatherDataError("invalid_data", "Hourly timestamps are invalid") from exc

    for field in ("weather_code", "is_day"):
        series = hourly.get(field)
        values[field] = dict(zip(indexed_times, series)) if isinstance(series, list) and len(series) == len(times) else {}
    hour_end = int(now // 3600) * 3600
    required_times = (hour_end - 3600, hour_end, hour_end + 3600, hour_end + 7200, hour_end + 10800)
    if any(timestamp not in values[key] for timestamp in required_times for key in fields):
        raise WeatherDataError("missing_data", "Required completed and forecast weather hours are missing")
    try:
        recent = [float(values["precipitation"][timestamp]) for timestamp in required_times[:2]]
        temperatures = [float(current[key]) for key in ("temperature_2m", "apparent_temperature")]
    except (KeyError, TypeError, ValueError) as exc:
        raise WeatherDataError("missing_data", "Required weather values are missing") from exc
    if not all(isfinite(value) and value >= 0 for value in recent):
        raise WeatherDataError("invalid_data", "Recent rainfall values are invalid")
    if not all(isfinite(value) for value in temperatures):
        raise WeatherDataError("invalid_data", "Current temperature values are invalid")

    forecast = []
    for timestamp in required_times[2:]:
        try:
            slot = {
                "valid_at": iso_utc(timestamp),
                "air_temperature_c": float(values["temperature_2m"][timestamp]),
                "feels_like_c": float(values["apparent_temperature"][timestamp]),
                "relative_humidity_pct": float(values["relative_humidity_2m"][timestamp]),
                "precipitation_mm": float(values["precipitation"][timestamp]),
                "weather_code": _optional_weather_int(values["weather_code"].get(timestamp), range(100)),
                "is_day": _optional_weather_int(values["is_day"].get(timestamp), range(2)),
            }
        except (TypeError, ValueError) as exc:
            raise WeatherDataError("missing_data", "Forecast weather values are missing") from exc
        if not all(isfinite(slot[key]) for key in ("air_temperature_c", "feels_like_c")):
            raise WeatherDataError("invalid_data", "Forecast temperature is invalid")
        if not isfinite(slot["relative_humidity_pct"]) or not 0 <= slot["relative_humidity_pct"] <= 100:
            raise WeatherDataError("invalid_data", "Forecast humidity is invalid")
        if not isfinite(slot["precipitation_mm"]) or slot["precipitation_mm"] < 0:
            raise WeatherDataError("invalid_data", "Forecast rainfall is invalid")
        forecast.append(slot)

    provenance = {
        "provider": "Open-Meteo",
        "api_version": "v1",
        "endpoint": WEATHER_URL,
        "model_selection": "provider default Best Match (automatic)",
        "cell_selection": "land",
        "model_identifier": None,
        "model_version": None,
        "model_note": "The response does not identify the exact model or model run.",
        "requested_location": WEATHER_LOCATION,
        "grid_cell_center": {
            "latitude": grid_latitude,
            "longitude": grid_longitude,
            "elevation_m": elevation_m,
        },
        "spatial_resolution_m": None,
        "spatial_resolution_note": "The API response does not provide one resolution for its automatically combined models.",
        "timezone": timezone_name,
        "utc_offset_seconds": utc_offset_seconds,
        "timestamps_are_unix_utc": True,
        "units": {
            "air_temperature": current_units["temperature_2m"],
            "apparent_temperature": current_units["apparent_temperature"],
            "relative_humidity": hourly_units["relative_humidity_2m"],
            "precipitation": hourly_units["precipitation"],
        },
        "retrieved_at": retrieved_at or iso_utc(int(now)),
    }
    return {
        "status": "ready",
        "source": SOURCE,
        "provenance": provenance,
        "valid_at": iso_utc(valid_at),
        "air_temperature_c": temperatures[0],
        "feels_like_c": temperatures[1],
        "weather_code": _optional_weather_int(current.get("weather_code"), range(100)),
        "is_day": _optional_weather_int(current.get("is_day"), range(2)),
        "recent_rain_mm": round(sum(recent), 2),
        "recent_through": iso_utc(hour_end),
        "upcoming_rain_mm": round(sum(slot["precipitation_mm"] for slot in forecast), 2),
        "forecast_through": iso_utc(hour_end + 10800),
        "hourly_forecast": forecast,
    }


@lru_cache(maxsize=2)
def weather_snapshot(_five_minute_slot: int) -> dict:
    payload = fetch_json(WEATHER_URL, {
        "latitude": WEATHER_LOCATION["latitude"], "longitude": WEATHER_LOCATION["longitude"],
        "current": "temperature_2m,apparent_temperature,weather_code,is_day",
        "hourly": "precipitation,temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day",
        "past_hours": 2, "forecast_hours": 4,
        "temperature_unit": "celsius", "precipitation_unit": "mm",
        "timeformat": "unixtime", "timezone": "UTC", "cell_selection": "land",
    })
    return {"payload": payload, "retrieved_at": iso_utc(int(time()))}


@lru_cache(maxsize=2)
def weather_report_snapshot(_five_minute_slot: int) -> dict:
    """Fetch enough hourly provider output for the next 48 complete forecast hours."""
    payload = fetch_json(WEATHER_URL, {
        "latitude": WEATHER_LOCATION["latitude"], "longitude": WEATHER_LOCATION["longitude"],
        "current": "temperature_2m,apparent_temperature",
        "hourly": "precipitation,temperature_2m,apparent_temperature,relative_humidity_2m",
        "past_hours": 2, "forecast_hours": 49,
        "temperature_unit": "celsius", "precipitation_unit": "mm",
        "timeformat": "unixtime", "timezone": "UTC", "cell_selection": "land",
    })
    return {"payload": payload, "retrieved_at": iso_utc(int(time()))}


def _unavailable(reason: str, checked_at: str) -> dict:
    messages = {
        "timeout": "The weather provider timed out. Try again later.",
        "provider_error": "The weather provider could not be reached.",
        "stale_data": "The latest weather estimate is stale or outside the supported time window.",
        "missing_data": "The provider did not return all required weather values or metadata.",
        "invalid_data": "The provider returned invalid weather values or units.",
    }
    return {
        "status": "unavailable",
        "source": SOURCE,
        "reason": reason,
        "checked_at": checked_at,
        "message": messages[reason],
    }


def get_weather() -> dict:
    checked_at = iso_utc(int(time()))
    try:
        now = time()
        snapshot = weather_snapshot(int(now // 300))
    except TimeoutError:
        return _unavailable("timeout", checked_at)
    except HTTPError as exc:
        if 400 <= exc.code < 500 and exc.code != 429:
            return _unavailable("invalid_data", checked_at)
        return _unavailable("provider_error", checked_at)
    except URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            return _unavailable("timeout", checked_at)
        return _unavailable("provider_error", checked_at)
    except json.JSONDecodeError:
        return _unavailable("invalid_data", checked_at)

    try:
        return parse_weather(snapshot["payload"], now, snapshot["retrieved_at"])
    except WeatherDataError as exc:
        return _unavailable(exc.reason, checked_at)


def parse_two_day_forecast(payload: dict, now: float, retrieved_at: str | None = None) -> dict:
    """Validate and return 48 hourly provider estimates after the current hour."""
    base = parse_weather(payload, now, retrieved_at)
    hourly = payload["hourly"]
    times = [int(timestamp) for timestamp in hourly["time"]]
    indexed = {timestamp: index for index, timestamp in enumerate(times)}
    hour_end = int(now // 3600) * 3600
    expected = [hour_end + 3600 * offset for offset in range(1, 49)]
    if any(timestamp not in indexed for timestamp in expected):
        raise WeatherDataError("missing_data", "The provider did not return a complete 48-hour forecast")

    fields = {
        "air_temperature_c": "temperature_2m",
        "feels_like_c": "apparent_temperature",
        "relative_humidity_pct": "relative_humidity_2m",
        "precipitation_mm": "precipitation",
    }
    forecast = []
    for timestamp in expected:
        index = indexed[timestamp]
        try:
            slot = {"valid_at": iso_utc(timestamp)}
            slot.update({name: float(hourly[source][index]) for name, source in fields.items()})
        except (KeyError, TypeError, ValueError) as exc:
            raise WeatherDataError("missing_data", "Forecast weather values are missing") from exc
        if not all(isfinite(slot[key]) for key in ("air_temperature_c", "feels_like_c")):
            raise WeatherDataError("invalid_data", "Forecast temperature is invalid")
        if not isfinite(slot["relative_humidity_pct"]) or not 0 <= slot["relative_humidity_pct"] <= 100:
            raise WeatherDataError("invalid_data", "Forecast humidity is invalid")
        if not isfinite(slot["precipitation_mm"]) or slot["precipitation_mm"] < 0:
            raise WeatherDataError("invalid_data", "Forecast rainfall is invalid")
        forecast.append(slot)
    return {
        "status": "ready",
        "source": SOURCE,
        "provenance": base["provenance"],
        "forecast_hours": len(forecast),
        "forecast_from": forecast[0]["valid_at"],
        "forecast_through": forecast[-1]["valid_at"],
        "hourly_forecast": forecast,
    }


def get_two_day_forecast() -> dict:
    checked_at = iso_utc(int(time()))
    try:
        now = time()
        snapshot = weather_report_snapshot(int(now // 300))
    except TimeoutError:
        return _unavailable("timeout", checked_at)
    except HTTPError as exc:
        if 400 <= exc.code < 500 and exc.code != 429:
            return _unavailable("invalid_data", checked_at)
        return _unavailable("provider_error", checked_at)
    except URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            return _unavailable("timeout", checked_at)
        return _unavailable("provider_error", checked_at)
    except (json.JSONDecodeError, OSError):
        return _unavailable("invalid_data", checked_at)

    try:
        return parse_two_day_forecast(snapshot["payload"], now, snapshot["retrieved_at"])
    except WeatherDataError as exc:
        return _unavailable(exc.reason, checked_at)


@lru_cache(maxsize=1)
def projected_grid():
    grid = load_grid()
    cells = [transform(PROJECT, Polygon(rings[0], rings[1:])).buffer(0) for _, rings, _, _ in grid["cells"]]
    return grid, cells, STRtree(cells)


def covered_km(line, geometries: list) -> float:
    return round(line.intersection(unary_union(geometries)).length / 1000, 2) if geometries else 0.0


def runoff_spans(line: LineString, wet_area) -> list[dict]:
    """Keep route order even when a path doubles back across the same road."""
    spans: list[dict] = []
    distance_before = 0.0
    length = line.length
    if length <= 0 or wet_area.is_empty:
        return spans
    prepared = prep(wet_area)
    for start, end in zip(line.coords[:-1], line.coords[1:]):
        if start == end:
            continue
        edge = LineString([start, end])
        ranges = []
        parts = get_parts(edge.intersection(wet_area)) if prepared.intersects(edge) else ()
        for part in parts:
            if part.geom_type != "LineString" or part.length <= 0:
                continue
            bounds = sorted((edge.project(Point(part.coords[0])), edge.project(Point(part.coords[-1]))))
            ranges.append(tuple((distance_before + value) / length for value in bounds))
        for low, high in sorted(ranges):
            if spans and low - spans[-1]["end"] < 1 / length:
                spans[-1]["end"] = max(spans[-1]["end"], high)
            else:
                spans.append({"start": low, "end": high})
        distance_before += edge.length
    return spans


def annotate_runoff(routes: list[dict], lines: list, weather: dict) -> bool:
    if weather["status"] != "ready":
        return False
    try:
        grid, cells, index = projected_grid()
    except FileNotFoundError:
        return False
    current = screen_values(grid, weather["recent_rain_mm"])
    projected = screen_values(grid, weather["recent_rain_mm"] + weather["upcoming_rain_mm"])
    for route, line in zip(routes, lines):
        nearby = [int(i) for i in index.query(line, predicate="intersects") if current[i] is not None]
        if not nearby:
            continue
        forecast_cells = [cells[i] for i in nearby if projected[i] >= RUNOFF_THRESHOLD_MM]
        forecast_area = unary_union(forecast_cells)
        route["runoff"] = {
            "covered_km": covered_km(line, [cells[i] for i in nearby]),
            "current_km": covered_km(line, [cells[i] for i in nearby if current[i] >= RUNOFF_THRESHOLD_MM]),
            "forecast_km": round(line.intersection(forecast_area).length / 1000, 2),
        }
        if weather["upcoming_rain_mm"] >= 5:
            route["forecast_runoff_spans"] = runoff_spans(line, forecast_area)
        route["runoff_comparable"] = route["runoff"]["covered_km"] >= 0.95 * line.length / 1000

    if len(routes) > 1 and all(route.get("runoff_comparable", False) for route in routes):
        ordered = sorted(routes, key=lambda route: route["runoff"]["forecast_km"])
        if ordered[-1]["runoff"]["forecast_km"] - ordered[0]["runoff"]["forecast_km"] >= 0.1:
            ordered[0]["labels"].append("Lower modeled runoff exposure")
    return True


def annotate_conditions(routes: list[dict], key: str | None) -> dict:
    weather = get_weather()
    lines = [transform(PROJECT, LineString(route["coordinates"])) for route in routes]
    runoff_available = annotate_runoff(routes, lines, weather)
    flood_reports = {"status": "unavailable", "source": "TomTom Traffic Incidents"}
    if key:
        try:
            payload = fetch_json(INCIDENT_URL, {
                "key": key, "bbox": "77.43,12.81,77.81,13.17",
                "categoryFilter": "Flooding", "timeValidityFilter": "present",
                "fields": "{incidents{geometry{type,coordinates},properties{id,iconCategory}}}",
            })
            incidents = [
                transform(PROJECT, shape(item["geometry"]))
                for item in payload["incidents"]
                if item["properties"]["iconCategory"] == 11 and item.get("geometry")
            ]
            for route, line in zip(routes, lines):
                route["nearby_flood_reports"] = sum(line.distance(incident) <= INCIDENT_PROXIMITY_M for incident in incidents)
            report_counts = sorted(routes, key=lambda route: route["nearby_flood_reports"])
            if report_counts[0]["nearby_flood_reports"] < report_counts[-1]["nearby_flood_reports"]:
                report_counts[0]["labels"].append("Fewer nearby reported floods")
            flood_reports["status"] = "ready"
            flood_reports["checked_at"] = iso_utc(int(time()))
        except PROVIDER_ERRORS:
            pass
    return {"weather": weather, "runoff_available": runoff_available, "flood_reports": flood_reports}
