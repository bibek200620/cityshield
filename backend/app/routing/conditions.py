"""Weather and flood context for Bengaluru road routes."""
from __future__ import annotations

import json
import logging
from copy import deepcopy
from datetime import datetime, timezone
from functools import lru_cache
from math import isfinite
from threading import Lock
from time import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import HTTPException
from pyproj import Transformer
from shapely import get_parts
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.ops import transform, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

from app.api.routes_city_flood import load_grid, screen_values
from app.core.config import settings
from app.routing.meteoblue import get_meteoblue_forecast

WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
INCIDENT_URL = "https://api.tomtom.com/traffic/services/5/incidentDetails"
WEATHER_LOCATION = {"latitude": 12.98, "longitude": 77.59}
WATCH_LOCATIONS = (WEATHER_LOCATION, {"latitude": 13.08, "longitude": 77.58},
                   {"latitude": 12.98, "longitude": 77.73}, {"latitude": 12.86, "longitude": 77.61},
                   {"latitude": 12.99, "longitude": 77.48})
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
logger = logging.getLogger("uvicorn.error")
_last_good_weather: dict[tuple[float, float], tuple[dict, float]] = {}
_last_good_weather_lock = Lock()


class WeatherDataError(ValueError):
    """A weather response that is stale, incomplete or invalid."""

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


def parse_weather(payload: dict, now: float, retrieved_at: str | None = None, *, location: dict | None = None) -> dict:
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
        raise WeatherDataError("invalid_data", "Weather units do not match the requested units")

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
        "cell_selection": "land",
        "model_identifier": None,
        "model_version": None,
        "model_note": "The response does not identify the exact model or model run.",
        "requested_location": location or WEATHER_LOCATION,
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


def weather_parameters() -> dict:
    return {
        "current": "temperature_2m,apparent_temperature,weather_code,is_day",
        "hourly": "precipitation,temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day",
        "past_hours": 2, "forecast_hours": 4,
        "temperature_unit": "celsius", "precipitation_unit": "mm",
        "timeformat": "unixtime", "timezone": "UTC", "cell_selection": "land",
    }


def fetch_weather(params: dict):
    try:
        return fetch_json(WEATHER_URL, params)
    except HTTPError as exc:
        logger.warning("Open-Meteo forecast request failed (HTTP %s)", exc.code)
        raise
    except URLError as exc:
        reason = exc.reason
        logger.warning(
            "Open-Meteo forecast connection failed (%s, errno=%s, certificate=%s)",
            type(reason).__name__, getattr(reason, "errno", None), getattr(reason, "verify_code", None),
        )
        raise


@lru_cache(maxsize=256)
def weather_snapshot(latitude: float, longitude: float, _five_minute_slot: int) -> dict:
    location = {"latitude": latitude, "longitude": longitude}
    payload = fetch_weather({**weather_parameters(), **location})
    return {"payload": payload, "retrieved_at": iso_utc(int(time())), "location": location}


@lru_cache(maxsize=2)
def city_watch_snapshot(_five_minute_slot: int) -> tuple[list, str]:
    payload = fetch_weather({
        **weather_parameters(),
        **{key: ",".join(str(location[key]) for location in WATCH_LOCATIONS) for key in ("latitude", "longitude")},
    })
    if not isinstance(payload, list) or len(payload) != len(WATCH_LOCATIONS):
        raise WeatherDataError("invalid_data", "The city watch requires all five forecast points")
    return payload, iso_utc(int(time()))


def get_alert_weather() -> list[dict]:
    now = time()
    try:
        payload, retrieved_at = city_watch_snapshot(int(now // 300))
        return [parse_weather(point, now, retrieved_at, location=location) for point, location in zip(payload, WATCH_LOCATIONS)]
    except (*PROVIDER_ERRORS, OSError):
        fallback = get_weather()
        return [fallback] if fallback["status"] == "ready" else []


@lru_cache(maxsize=8)
def nearest_forecast_points(locations: tuple[tuple[float, float], ...]) -> tuple[int, ...]:
    """Assign each municipal grid cell to the nearest forecast grid point."""
    projected = [PROJECT(*location) for location in locations]
    zones = []
    for _, rings, *_ in load_grid()["cells"]:
        centroid = Polygon(rings[0], rings[1:]).centroid
        x, y = PROJECT(centroid.x, centroid.y)
        zones.append(min(range(len(projected)), key=lambda i: (projected[i][0] - x) ** 2 + (projected[i][1] - y) ** 2))
    return tuple(zones)


@lru_cache(maxsize=128)
def weather_report_snapshot(latitude: float, longitude: float, _five_minute_slot: int) -> dict:
    """Fetch enough hourly forecast output for the next 48 complete hours."""
    payload = fetch_weather({
        "latitude": latitude, "longitude": longitude,
        "current": "temperature_2m,apparent_temperature",
        "hourly": "precipitation,temperature_2m,apparent_temperature,relative_humidity_2m",
        "past_hours": 2, "forecast_hours": 49,
        "temperature_unit": "celsius", "precipitation_unit": "mm",
        "timeformat": "unixtime", "timezone": "UTC", "cell_selection": "land",
    })
    return {"payload": payload, "retrieved_at": iso_utc(int(time())),
            "location": {"latitude": latitude, "longitude": longitude}}


def _unavailable(reason: str, checked_at: str) -> dict:
    messages = {
        "timeout": "The weather service timed out. Try again later.",
        "upstream_error": "The weather service could not be reached.",
        "stale_data": "The latest weather estimate is stale or outside the supported time window.",
        "missing_data": "The forecast service did not return all required weather values or metadata.",
        "invalid_data": "The forecast service returned invalid weather values or units.",
    }
    return {
        "status": "unavailable",
        "reason": reason,
        "checked_at": checked_at,
        "message": messages[reason],
    }


def _alternate_weather(latitude: float, longitude: float, now: float, *, report: bool = False) -> dict | None:
    """Use the configured hourly point forecast when the primary provider fails."""
    if not settings.METEOBLUE_API_KEY:
        return None
    try:
        point = get_meteoblue_forecast(round(latitude, 4), round(longitude, 4), int(now // 300))
        hourly = {}
        for row in point["hours"]:
            valid = datetime.fromisoformat(row["valid_at"])
            if valid.utcoffset() is None:
                return None
            hourly[int(valid.timestamp())] = {**row, "valid_at": iso_utc(int(valid.timestamp()))}
        hour = int(now // 3600) * 3600
        count = 48 if report else 3
        slots = [hourly[hour + offset * 3600] for offset in range(1, count + 1)]
        coordinates = point["location"]
        lat = float(coordinates["latitude"])
        lng = float(coordinates["longitude"])
        if not -90 <= lat <= 90 or not -180 <= lng <= 180:
            return None
        provenance = {
            "source": "Meteoblue",
            "cell_selection": "provider point forecast",
            "model_identifier": None,
            "model_version": None,
            "model_run": point.get("model_run"),
            "model_note": "Alternate hourly point forecast. Values are model estimates.",
            "requested_location": {"latitude": latitude, "longitude": longitude},
            "grid_cell_center": {
                "latitude": lat,
                "longitude": lng,
                "elevation_m": point.get("elevation_m"),
            },
            "spatial_resolution_m": None,
            "spatial_resolution_note": "The alternate point forecast does not specify a grid resolution.",
            "timezone": "UTC",
            "utc_offset_seconds": 0,
            "timestamps_are_unix_utc": True,
            "units": WEATHER_UNITS,
            "retrieved_at": point["retrieved_at"],
        }
        result = {"status": "ready", "provenance": provenance,
                  "forecast_through": slots[-1]["valid_at"], "hourly_forecast": slots}
        if report:
            return {**result, "forecast_hours": count, "forecast_from": slots[0]["valid_at"]}
        current = hourly[hour]
        recent = current["precipitation_mm"] + hourly[hour - 3600]["precipitation_mm"]
        return {
            **result,
            "valid_at": current["valid_at"],
            "air_temperature_c": current["air_temperature_c"],
            "feels_like_c": current["feels_like_c"],
            "relative_humidity_pct": current["relative_humidity_pct"],
            "recent_rain_mm": round(recent, 2),
            "recent_through": current["valid_at"],
            "upcoming_rain_mm": round(sum(slot["precipitation_mm"] for slot in slots), 2),
        }
    except (HTTPException, KeyError, TypeError, ValueError, OverflowError):
        return None


def get_weather(latitude: float = WEATHER_LOCATION["latitude"], longitude: float = WEATHER_LOCATION["longitude"]) -> dict:
    now = time()
    checked_at = iso_utc(int(now))

    def unavailable(reason: str) -> dict:
        fallback = _alternate_weather(latitude, longitude, now)
        if fallback is not None:
            return fallback
        key = (round(latitude, 4), round(longitude, 4))
        with _last_good_weather_lock:
            cached = _last_good_weather.get(key)
        if cached and time() - cached[1] <= 60 * 60:
            stale = deepcopy(cached[0])
            stale["is_stale"] = True
            stale["stale_age_seconds"] = int(time() - cached[1])
            return stale
        return _unavailable(reason, checked_at)

    try:
        snapshot = weather_snapshot(latitude, longitude, int(now // 300))
    except TimeoutError:
        return unavailable("timeout")
    except HTTPError as exc:
        if 400 <= exc.code < 500 and exc.code != 429:
            return unavailable("invalid_data")
        return unavailable("upstream_error")
    except URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            return unavailable("timeout")
        return unavailable("upstream_error")
    except json.JSONDecodeError:
        return unavailable("invalid_data")

    try:
        response = parse_weather(snapshot["payload"], now, snapshot["retrieved_at"], location=snapshot["location"])
    except WeatherDataError as exc:
        return unavailable(exc.reason)
    key = (round(latitude, 4), round(longitude, 4))
    with _last_good_weather_lock:
        _last_good_weather[key] = (response, now)
    return response


def parse_two_day_forecast(payload: dict, now: float, retrieved_at: str | None = None,
                           location: dict | None = None) -> dict:
    """Validate and return 48 hourly forecast estimates after the current hour."""
    base = parse_weather(payload, now, retrieved_at, location=location)
    hourly = payload["hourly"]
    times = [int(timestamp) for timestamp in hourly["time"]]
    indexed = {timestamp: index for index, timestamp in enumerate(times)}
    hour_end = int(now // 3600) * 3600
    expected = [hour_end + 3600 * offset for offset in range(1, 49)]
    if any(timestamp not in indexed for timestamp in expected):
        raise WeatherDataError("missing_data", "The forecast service did not return a complete 48-hour outlook")

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
        "provenance": base["provenance"],
        "forecast_hours": len(forecast),
        "forecast_from": forecast[0]["valid_at"],
        "forecast_through": forecast[-1]["valid_at"],
        "hourly_forecast": forecast,
    }


def get_two_day_forecast(latitude: float = WEATHER_LOCATION["latitude"], longitude: float = WEATHER_LOCATION["longitude"]) -> dict:
    now = time()
    checked_at = iso_utc(int(now))

    def unavailable(reason: str) -> dict:
        return _alternate_weather(latitude, longitude, now, report=True) or _unavailable(reason, checked_at)

    try:
        snapshot = weather_report_snapshot(latitude, longitude, int(now // 300))
    except TimeoutError:
        return unavailable("timeout")
    except HTTPError as exc:
        if 400 <= exc.code < 500 and exc.code != 429:
            return unavailable("invalid_data")
        return unavailable("upstream_error")
    except URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            return unavailable("timeout")
        return unavailable("upstream_error")
    except (json.JSONDecodeError, OSError):
        return unavailable("invalid_data")

    try:
        return parse_two_day_forecast(snapshot["payload"], now, snapshot["retrieved_at"], location=snapshot["location"])
    except WeatherDataError as exc:
        return unavailable(exc.reason)


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
        if weather["upcoming_rain_mm"] > 0:
            route["forecast_runoff_spans"] = runoff_spans(line, forecast_area)
        route["runoff_comparable"] = route["runoff"]["covered_km"] >= 0.95 * line.length / 1000

    if len(routes) > 1 and all(route.get("runoff_comparable", False) for route in routes):
        ordered = sorted(routes, key=lambda route: route["runoff"]["forecast_km"])
        if ordered[-1]["runoff"]["forecast_km"] - ordered[0]["runoff"]["forecast_km"] >= 0.1:
            ordered[0]["labels"].append("Lower modeled runoff exposure")
    return True


def scenario_route_exposure(lines: list[LineString], rainfall_mm: float) -> list[dict]:
    grid, cells, index = projected_grid()
    values = screen_values(grid, rainfall_mm)
    results = []
    for line in lines:
        nearby = [int(i) for i in index.query(line, predicate="intersects") if values[i] is not None]
        wet = unary_union([cells[i] for i in nearby if values[i] >= RUNOFF_THRESHOLD_MM])
        high = unary_union([cells[i] for i in nearby if values[i] > 20])
        results.append({
            "covered_km": covered_km(line, [cells[i] for i in nearby]),
            "route_km": line.length / 1000,
            "exposed_km": line.intersection(wet).length / 1000,
            "high_km": line.intersection(high).length / 1000,
            "spans": runoff_spans(line, wet),
            "high_spans": runoff_spans(line, high),
        })
    return results


def annotate_conditions(routes: list[dict], key: str | None, latitude: float = WEATHER_LOCATION["latitude"],
                        longitude: float = WEATHER_LOCATION["longitude"], *, bengaluru_only: bool = True) -> dict:
    weather = get_weather(latitude, longitude)
    if not bengaluru_only:
        return {"weather": weather, "runoff_available": False,
                "flood_reports": {"status": "unavailable", "source": "TomTom Traffic Incidents"}}
    lines = [transform(PROJECT, LineString(route["coordinates"])) for route in routes]
    runoff_available = annotate_runoff(routes, lines, weather)
    flood_reports = {"status": "unavailable", "source": "TomTom Traffic Incidents"}
    if key:
        try:
            payload = fetch_json(INCIDENT_URL, {
                "key": key, "bbox": "77.43,12.61,77.81,13.17",
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
