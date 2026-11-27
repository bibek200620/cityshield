"""Grounded alerts and optional, bounded Gemini phrasing for the map mascot."""
from __future__ import annotations

import json
import re
from functools import lru_cache
from threading import BoundedSemaphore, Lock
from time import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter
from pydantic import BaseModel, Field
from shapely.geometry import LineString, Polygon
from shapely.ops import transform

from app.api.routes_city_flood import load_grid, screen_values
from app.api.routes_driving import traffic_segments
from app.core.config import settings
from app.routing.conditions import PROJECT, PROVIDER_ERRORS, annotate_runoff, fetch_json, get_alert_weather, get_weather, iso_utc

router = APIRouter(prefix="/api/assistant")
ALERT_KINDS = ("city_flood", "route_rain", "traffic")
PHRASINGS = ("direct", "gentle")
DEFAULT_STYLE = dict.fromkeys(ALERT_KINDS, "direct")
CITY_RUNOFF_MM = 5
CITY_MIN_CELLS = 10
HEAT_FEELS_LIKE_C = 40
_phrasing_lock = Lock()
_refresh_slots = BoundedSemaphore(3)


class RouteContextRequest(BaseModel):
    coordinates: list[tuple[float, float]] = Field(min_length=2, max_length=6000)
    tomtom: bool = False


@lru_cache(maxsize=64)
def _refreshed_traffic(coordinates: tuple[tuple[float, float], ...], _five_minute_slot: int) -> dict | None:
    secret = settings.TOMTOM_API_KEY
    if not secret or not _refresh_slots.acquire(blocking=False):
        return None
    try:
        endpoints = ":".join(f"{lat:.6f},{lng:.6f}" for lng, lat in (coordinates[0], coordinates[-1]))
        payload = fetch_json(f"https://api.tomtom.com/routing/1/calculateRoute/{endpoints}/json", {
            "key": secret.get_secret_value().strip(),
            "travelMode": "car", "traffic": "true", "sectionType": "traffic",
            "routeRepresentation": "polyline", "reconstructionMode": "strict", "maxAlternatives": 0,
        }, body={"supportingPoints": [{"latitude": lat, "longitude": lng} for lng, lat in coordinates]})
        route = payload["routes"][0]
        refreshed = tuple((float(point["longitude"]), float(point["latitude"]))
                          for leg in route["legs"] for point in leg["points"])
        if refreshed != coordinates:
            return None
        segments = traffic_segments(route, len(refreshed))
        return {"checked_at": iso_utc(int(time())), "segments": segments} if segments is not None else None
    except PROVIDER_ERRORS:
        return None
    finally:
        _refresh_slots.release()


@router.post("/route-context")
def assistant_route_context(request: RouteContextRequest) -> dict:
    coordinates = tuple(request.coordinates)
    if not all(77.39 <= lng <= 77.85 and 12.57 <= lat <= 13.21 for lng, lat in coordinates):
        return {"status": "unavailable"}
    line = transform(PROJECT, LineString(coordinates))
    weather = get_weather()
    model = {"labels": []}
    annotate_runoff([model], [line], weather)
    traffic = _refreshed_traffic(coordinates, int(time() // 300)) if request.tomtom else None
    return {
        "status": "ready", "weather": weather, "traffic": traffic,
        "forecast_runoff_spans": model.get("forecast_runoff_spans", []),
    }


@router.get("/outlook")
def assistant_outlook() -> dict:
    forecasts = get_alert_weather()
    if not forecasts:
        return {"status": "unavailable"}
    alert = None
    flood_screen_available = True
    locations = tuple((item["longitude"], item["latitude"]) for forecast in forecasts
                      if (item := forecast.get("provenance", {}).get("grid_cell_center")))
    if any(weather["upcoming_rain_mm"] > 0 for weather in forecasts):
        try:
            grid = load_grid()
        except FileNotFoundError:
            flood_screen_available = False
        else:
            zones = _nearest_forecast_points(locations) if len(locations) > 1 else (0,) * len(grid["cells"])
            rainfall = [weather["recent_rain_mm"] for weather in forecasts]
            for hours in zip(*(weather["hourly_forecast"] for weather in forecasts)):
                if not any(hour["precipitation_mm"] for hour in hours):
                    continue
                rainfall = [total + hour["precipitation_mm"] for total, hour in zip(rainfall, hours)]
                scores = {total: screen_values(grid, total) for total in set(rainfall)}
                affected = {
                    cell_id.rsplit(":", 1)[0] for index, ((cell_id, *_), zone) in enumerate(zip(grid["cells"], zones))
                    if (score := scores[rainfall[zone]][index]) is not None and score >= CITY_RUNOFF_MM
                }
                if len(affected) >= CITY_MIN_CELLS:
                    alert = {"valid_at": hours[0]["valid_at"], "cells": len(affected)}
                    break
    heat_candidates = [
        {"valid_at": hour["valid_at"], "feels_like_c": hour["feels_like_c"]}
        for weather in forecasts for hour in [weather, *weather["hourly_forecast"]]
        if hour.get("feels_like_c", float("-inf")) >= HEAT_FEELS_LIKE_C
    ]
    heat = min(heat_candidates, key=lambda item: (item["valid_at"], -item["feels_like_c"])) if heat_candidates else None
    return {
        "status": "ready",
        "checked_at": iso_utc(int(time())),
        "forecast_through": forecasts[0]["forecast_through"],
        "forecast_points": len(set(locations)) or 1,
        "alert": alert,
        "flood_screen_available": flood_screen_available,
        "heat": heat,
    }


@lru_cache(maxsize=8)
def _nearest_forecast_points(locations: tuple[tuple[float, float], ...]) -> tuple[int, ...]:
    projected = [PROJECT(*location) for location in locations]
    zones = []
    for _, rings, *_ in load_grid()["cells"]:
        centroid = Polygon(rings[0], rings[1:]).centroid
        x, y = PROJECT(centroid.x, centroid.y)
        zones.append(min(range(len(projected)), key=lambda i: (projected[i][0] - x) ** 2 + (projected[i][1] - y) ** 2))
    return tuple(zones)


@lru_cache(maxsize=1)
def _gemini_phrasings(_six_hour_slot: int) -> dict:
    key = settings.GEMINI_API_KEY
    model = settings.GEMINI_MODEL
    if not key or not key.get_secret_value().strip() or not re.fullmatch(r"gemini-[a-z0-9.-]+", model):
        return {"source": "preset", "styles": DEFAULT_STYLE}

    payload = {
        "contents": [{"parts": [{"text": (
            "Choose between direct and gentle delivery for three short spoken alerts in a "
            "driving map. Direct means start immediately with the event. Gentle means a brief "
            "friendly heads-up before the same event. Prefer direct during time-sensitive "
            "driving. The system supplies every alert fact and action. Return only the tone "
            "for city flood watch, modeled runoff on a driving route, and traffic ahead."
        )}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {kind: {"type": "STRING", "enum": list(PHRASINGS)} for kind in ALERT_KINDS},
                "required": list(ALERT_KINDS),
            },
            "maxOutputTokens": 192,
        },
    }
    def generate(model_id: str) -> dict:
        request = Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "x-goog-api-key": key.get_secret_value().strip()},
            method="POST",
        )
        with urlopen(request, timeout=8) as response:
            return json.load(response)

    try:
        try:
            result = generate(model)
        except HTTPError as error:
            if error.code != 404 or model != "gemini-2.5-flash-lite":
                raise
            model = "gemini-3.5-flash-lite"
            result = generate(model)
        text = result["candidates"][0]["content"]["parts"][-1]["text"]
        styles = json.loads(text)
        if not isinstance(styles, dict) or set(styles) != set(ALERT_KINDS):
            raise ValueError("Unexpected Gemini keys")
        if any(styles[kind] not in PHRASINGS for kind in ALERT_KINDS):
            raise ValueError("Unexpected Gemini tone")
        return {"source": "gemini", "model": model, "styles": styles}
    except (URLError, TimeoutError, ValueError, KeyError, IndexError, TypeError):
        return {"source": "preset", "styles": DEFAULT_STYLE}


@router.get("/phrasing")
def assistant_phrasing() -> dict:
    # Serialize cache fills so concurrent maps share one bounded provider request.
    with _phrasing_lock:
        return _gemini_phrasings(int(time() // (6 * 3600)))
