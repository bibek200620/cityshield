"""Weather and flood context for Bengaluru road routes."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from functools import lru_cache
from math import isfinite
from time import time
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pyproj import Transformer
from shapely.geometry import LineString, Polygon, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree

from app.api.routes_city_flood import load_grid, screen_values

WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
INCIDENT_URL = "https://api.tomtom.com/traffic/services/5/incidentDetails"
SOURCE = "Open-Meteo weather model"
RUNOFF_THRESHOLD_MM = 1.0
INCIDENT_PROXIMITY_M = 35
PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True).transform
PROVIDER_ERRORS = (URLError, TimeoutError, KeyError, TypeError, ValueError, IndexError)


def fetch_json(url: str, params: dict) -> dict:
    request = Request(url + "?" + urlencode(params), headers={"User-Agent": "CityShield/0.1 (local research)"})
    with urlopen(request, timeout=6) as response:
        return json.load(response)


def iso_utc(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def parse_weather(payload: dict, now: float) -> dict:
    current = payload["current"]
    valid_at = int(current["time"])
    if not -900 <= now - valid_at <= 3600:
        raise ValueError("Current weather is stale or too far in the future")
    hourly = payload["hourly"]
    if not len(hourly["time"]) == len(hourly["precipitation"]):
        raise ValueError("Misaligned rainfall series")
    hour_end = int(now // 3600) * 3600
    rain = dict(zip(hourly["time"], hourly["precipitation"]))
    recent = [float(rain[t]) for t in (hour_end - 3600, hour_end)]
    future = [float(rain[t]) for t in (hour_end + 3600, hour_end + 7200)]
    temperatures = [float(current[key]) for key in ("temperature_2m", "apparent_temperature")]
    if not all(isfinite(value) and value >= 0 for value in (*recent, *future)):
        raise ValueError("Invalid rainfall")
    if not all(isfinite(value) for value in temperatures):
        raise ValueError("Invalid temperature")
    return {
        "status": "ready",
        "source": SOURCE,
        "valid_at": iso_utc(valid_at),
        "air_temperature_c": temperatures[0],
        "feels_like_c": temperatures[1],
        "recent_rain_mm": round(sum(recent), 2),
        "recent_through": iso_utc(hour_end),
        "upcoming_rain_mm": round(sum(future), 2),
        "forecast_through": iso_utc(hour_end + 7200),
    }


@lru_cache(maxsize=2)
def weather_payload(_five_minute_slot: int) -> dict:
    return fetch_json(WEATHER_URL, {
        "latitude": 12.98, "longitude": 77.59,
        "current": "temperature_2m,apparent_temperature",
        "hourly": "precipitation", "past_hours": 2, "forecast_hours": 4,
        "timeformat": "unixtime", "timezone": "UTC",
    })


def get_weather() -> dict:
    try:
        now = time()
        return parse_weather(weather_payload(int(now // 300)), now)
    except PROVIDER_ERRORS:
        return {"status": "unavailable", "source": SOURCE, "message": "Fresh weather estimates unavailable."}


@lru_cache(maxsize=1)
def projected_grid():
    grid = load_grid()
    cells = [transform(PROJECT, Polygon(rings[0], rings[1:])).buffer(0) for _, rings, _, _ in grid["cells"]]
    return grid, cells, STRtree(cells)


def covered_km(line, geometries: list) -> float:
    return round(line.intersection(unary_union(geometries)).length / 1000, 2) if geometries else 0.0


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
        route["runoff"] = {
            "covered_km": covered_km(line, [cells[i] for i in nearby]),
            "current_km": covered_km(line, [cells[i] for i in nearby if current[i] >= RUNOFF_THRESHOLD_MM]),
            "forecast_km": covered_km(line, [cells[i] for i in nearby if projected[i] >= RUNOFF_THRESHOLD_MM]),
        }

    if len(routes) > 1 and all(
        "runoff" in route and route["runoff"]["covered_km"] >= 0.95 * line.length / 1000
        for route, line in zip(routes, lines)
    ):
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
