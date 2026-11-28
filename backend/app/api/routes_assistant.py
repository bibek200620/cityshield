"""Grounded alerts and optional Gemini speech text for the map mascot."""
from __future__ import annotations

import json
import logging
import re
from collections import deque
from functools import lru_cache
from threading import BoundedSemaphore, Lock
from time import monotonic, sleep, time
from typing import Annotated, Literal, get_args
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from shapely.geometry import LineString
from shapely.ops import transform

from app.api.routes_city_flood import load_grid, screen_values
from app.api.routes_driving import traffic_segments
from app.core.config import settings
from app.routing.conditions import PROJECT, PROVIDER_ERRORS, annotate_runoff, fetch_json, get_alert_weather, get_weather, iso_utc
from app.routing.conditions import nearest_forecast_points as _nearest_forecast_points

router = APIRouter(prefix="/api/assistant")
ALERT_KINDS = ("city_flood", "route_rain", "traffic")
PHRASINGS = ("direct", "gentle")
DEFAULT_STYLE = dict.fromkeys(ALERT_KINDS, "direct")
CITY_RUNOFF_MM = 5
CITY_MIN_CELLS = 10
HEAT_FEELS_LIKE_C = 40
_phrasing_lock = Lock()
_refresh_slots = BoundedSemaphore(3)
_conversation_slots = BoundedSemaphore(2)
_conversation_lock = Lock()
_conversation_calls: deque[float] = deque()
_CHAT_MINUTE_LIMIT = 12
_CHAT_DAY_LIMIT = 250
logger = logging.getLogger("uvicorn.error")

CXText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
CXPlace = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=120)]
CXDecisionKind = Literal[
    "reply", "route", "weather", "eta", "direction", "show-place", "layer", "workspace",
    "pan", "zoom", "reset-map", "simulation", "stop-simulation", "flood-demo",
]
CXLayer = Literal["floodDepth", "heat", "cityRoads", "surfaceTemperature", "combined"]
CXWorkspace = Literal["map", "rainfall", "drive", "weatherReport", "outlook", "replay", "data", "compare"]
CXPanDirection = Literal["left", "right", "up", "down", "north", "south", "east", "west"]
CXSimulationPreset = Literal["light", "moderate", "heavy"]
CXVisibility = Literal["on", "off", "toggle"]


class ConversationTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: CXText


class ConversationRequest(BaseModel):
    message: CXText
    history: list[ConversationTurn] = Field(default_factory=list, max_length=4)


class ConversationDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: CXDecisionKind
    reply: CXText | None = None
    source: CXPlace | None = None
    destination: CXPlace | None = None
    query: CXPlace | None = None
    day: Literal["today", "tomorrow"] | None = None
    hours: Annotated[int, Field(strict=True, ge=1, le=720)] | None = None
    at_end: bool = False
    focus: Literal["rain_probability"] | None = None
    layer: CXLayer | None = None
    visibility: CXVisibility | None = None
    panel: CXWorkspace | None = None
    direction: CXPanDirection | None = None
    steps: Annotated[int, Field(strict=True, ge=-3, le=3)] | None = None
    preset: CXSimulationPreset | None = None
    intensity: Annotated[float, Field(strict=True, ge=5, le=150)] | None = None
    duration: Annotated[float, Field(strict=True, ge=15, le=180)] | None = None


_CX_ACTION_FIELDS = {
    "reply": {"type": "STRING", "description": "Short spoken answer or clarifying question."},
    "source": {"type": "STRING", "description": "Exact starting place phrase from the user, if supplied."},
    "destination": {"type": "STRING", "description": "Exact destination phrase from the user for a route."},
    "query": {"type": "STRING", "description": "Exact place or landmark phrase from the user for show-place."},
    "day": {"type": "STRING", "enum": ["today", "tomorrow"]},
    "hours": {"type": "INTEGER"},
    "at_end": {"type": "BOOLEAN", "description": "For weather at a point in time, such as in four hours."},
    "focus": {"type": "STRING", "enum": ["rain_probability"], "description": "Use when the user asks for a chance or probability of rain."},
    "layer": {"type": "STRING", "enum": list(get_args(CXLayer))},
    "visibility": {"type": "STRING", "enum": list(get_args(CXVisibility)), "description": "What to do with the layer."},
    "panel": {"type": "STRING", "enum": list(get_args(CXWorkspace))},
    "direction": {"type": "STRING", "enum": list(get_args(CXPanDirection))},
    "steps": {"type": "INTEGER", "description": "Zoom levels from -3 to 3, excluding zero. Positive zooms in."},
    "preset": {"type": "STRING", "enum": list(get_args(CXSimulationPreset))},
    "intensity": {"type": "NUMBER", "description": "Rainfall rate from 5 to 150 millimetres per hour."},
    "duration": {"type": "NUMBER", "description": "Simulation duration from 15 to 180 minutes."},
}


def _decision_variant(kind: CXDecisionKind, required: tuple[str, ...] = (), optional: tuple[str, ...] = ()) -> dict:
    fields = required + optional
    return {
        "type": "OBJECT",
        "properties": {"kind": {"type": "STRING", "enum": [kind]}, **{field: _CX_ACTION_FIELDS[field] for field in fields}},
        "required": ["kind", *required],
        "propertyOrdering": ["kind", *fields],
    }


_CX_DECISION_SCHEMA = {
    "anyOf": [
        _decision_variant("reply", ("reply",)),
        _decision_variant("route", ("destination",), ("source",)),
        _decision_variant("weather", (), ("day", "hours", "at_end", "focus")),
        _decision_variant("eta"),
        _decision_variant("direction"),
        _decision_variant("show-place", ("query",)),
        _decision_variant("layer", ("layer", "visibility")),
        _decision_variant("workspace", ("panel",)),
        _decision_variant("pan", ("direction",)),
        _decision_variant("zoom", ("steps",)),
        _decision_variant("reset-map"),
        _decision_variant("simulation", ("preset",)),
        _decision_variant("simulation", ("intensity", "duration")),
        _decision_variant("stop-simulation"),
        _decision_variant("flood-demo"),
    ],
}


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
    if not all(68 <= lng <= 98 and 6 <= lat <= 38 for lng, lat in coordinates):
        return {"status": "unavailable"}
    line = transform(PROJECT, LineString(coordinates))
    longitude, latitude = coordinates[0]
    weather = get_weather(latitude, longitude)
    model = {"labels": []}
    bengaluru_route = all(77.39 <= lng <= 77.85 and 12.57 <= lat <= 13.21 for lng, lat in coordinates)
    if bengaluru_route:
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


def _gemini_config() -> tuple[str, str] | None:
    key = settings.GEMINI_API_KEY
    model = settings.GEMINI_MODEL
    if not key or not key.get_secret_value().strip() or not re.fullmatch(r"gemini-[a-z0-9.-]+", model):
        return None
    return key.get_secret_value().strip(), model


def _generate_with_gemini(config: tuple[str, str], payload: dict, *, timeout: float, retry_transient: bool = False) -> tuple[str, str]:
    key, model = config
    deadline = monotonic() + timeout

    def generate(model_id: str) -> str:
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError
        request = Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        with urlopen(request, timeout=min(5, remaining) if retry_transient else remaining) as response:
            data = json.load(response)
        candidate = data["candidates"][0]
        if not isinstance(candidate, dict) or candidate.get("finishReason", "STOP") != "STOP":
            raise ValueError("Incomplete Gemini response")
        text = candidate["content"]["parts"][-1]["text"]
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Gemini returned no text")
        return text.strip()

    def generate_with_legacy_fallback() -> tuple[str, str]:
        nonlocal model
        try:
            return generate(model), model
        except HTTPError as error:
            if error.code != 404 or model != "gemini-2.5-flash-lite":
                raise
        model = "gemini-3.5-flash-lite"
        return generate(model), model

    try:
        return generate_with_legacy_fallback()
    except (URLError, TimeoutError) as error:
        if not retry_transient or deadline - monotonic() <= 1:
            raise
        if isinstance(error, HTTPError) and error.code not in {500, 502, 503, 504}:
            raise
        sleep(0.25)
        return generate_with_legacy_fallback()


@lru_cache(maxsize=1)
def _gemini_phrasings(_six_hour_slot: int) -> dict:
    config = _gemini_config()
    if config is None:
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
    try:
        text, model = _generate_with_gemini(config, payload, timeout=8)
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


def _reserve_conversation_call() -> bool:
    with _conversation_lock:
        now = monotonic()
        while _conversation_calls and _conversation_calls[0] <= now - 86400:
            _conversation_calls.popleft()
        if len(_conversation_calls) >= _CHAT_DAY_LIMIT or (
            len(_conversation_calls) >= _CHAT_MINUTE_LIMIT and _conversation_calls[-_CHAT_MINUTE_LIMIT] > now - 60
        ):
            return False
        _conversation_calls.append(now)
        return True


def _user_mentioned_place(place: str, messages: list[str]) -> bool:
    pattern = rf"(?<!\w){re.escape(place.casefold())}(?!\w)"
    return any(re.search(pattern, message.casefold()) for message in messages)


def _conversation_response(decision: ConversationDecision, request: ConversationRequest) -> dict:
    if decision.kind == "reply":
        if not decision.reply:
            raise ValueError("Missing spoken reply")
        return {"status": "ready", "reply": " ".join(decision.reply.split())}
    action = {"kind": decision.kind}
    if decision.kind == "route":
        if not decision.destination:
            raise ValueError("Missing route destination")
        messages = [turn.text for turn in request.history if turn.role == "user"] + [request.message]
        if any(place and not _user_mentioned_place(place, messages) for place in (decision.source, decision.destination)):
            raise ValueError("Route endpoint missing from user's conversation")
        action.update(source=decision.source, destination=decision.destination)
    elif decision.kind == "weather":
        if decision.day and decision.hours:
            raise ValueError("Conflicting forecast periods")
        day = decision.day or ("today" if decision.focus == "rain_probability" and not decision.hours else None)
        action.update(day=day, hours=decision.hours, at_end=decision.at_end)
        if decision.focus:
            action["focus"] = decision.focus
    elif decision.kind == "show-place":
        if not decision.query or not _user_mentioned_place(decision.query, [request.message]):
            raise ValueError("Map place missing from user's request")
        action["query"] = decision.query
    elif decision.kind == "layer":
        if not decision.layer:
            raise ValueError("Missing layer")
        if not decision.visibility:
            return {"status": "ready", "reply": "Would you like that layer on or off?"}
        action["layer"] = decision.layer
        if decision.visibility != "toggle":
            action["enabled"] = decision.visibility == "on"
    elif decision.kind == "workspace":
        if not decision.panel:
            raise ValueError("Missing workspace")
        action["panel"] = decision.panel
    elif decision.kind == "pan":
        if not decision.direction:
            raise ValueError("Missing pan direction")
        action["direction"] = decision.direction
    elif decision.kind == "zoom":
        if not decision.steps:
            raise ValueError("Missing zoom steps")
        action["steps"] = decision.steps
    elif decision.kind == "simulation":
        if decision.preset and decision.intensity is None and decision.duration is None:
            action["preset"] = decision.preset
        elif not decision.preset and decision.intensity is not None and decision.duration is not None:
            action.update(intensity=decision.intensity, duration=decision.duration)
        else:
            raise ValueError("Missing or conflicting simulation settings")
    return {"status": "ready", "reply": "I’ll check that for you.", "action": action}


@router.post("/conversation")
def assistant_conversation(request: ConversationRequest) -> dict:
    config = _gemini_config() if settings.CX_CONVERSATION_ENABLED else None
    if config is None:
        return {"status": "unavailable", "reason": "disabled"}
    if not _conversation_slots.acquire(blocking=False):
        return {"status": "unavailable", "reason": "busy"}
    try:
        if not _reserve_conversation_call():
            return {"status": "unavailable", "reason": "busy"}
        contents = [
            {"role": "model" if turn.role == "assistant" else "user", "parts": [{"text": turn.text}]}
            for turn in request.history
        ]
        contents.append({"role": "user", "parts": [{"text": request.message}]})
        text, _model = _generate_with_gemini(config, {
            "systemInstruction": {"parts": [{"text": (
                "You are C X, a conversational voice companion for CityShield's India travel and weather map. "
                "Use the whole current message and prior turns to understand intent. Limit help to travel, local "
                "weather, navigation, CityShield, and brief social exchanges. Politely redirect unrelated questions. "
                "Use reply for a natural answer, a correction, or one short clarifying question. Do not echo the "
                "user's words or make claims about app capabilities you were not given. Speak in one or two short "
                "plain-English sentences without lists or markdown. "
                "Interpret naturally phrased requests for site controls. Only return an action for a clear, "
                "affirmative request to do it now. For a hypothetical, negative, explanatory, or unclear "
                "request, reply or ask a clarifying question. Only return one action per turn. "
                "Use show-place to center the map on a named city, neighbourhood, or landmark, including "
                "requests to pan, focus, or zoom to a named place. Copy the exact place phrase from the "
                "current message into query, including any city, state, or neighbourhood qualifier. For "
                "example, for a closer look at Lalbagh in Bengaluru, query is Lalbagh in Bengaluru. "
                "When the user wants to look at a place, never return route. "
                "Use pan for a compass or screen direction, zoom for relative zoom, and reset-map for the "
                "India overview. Use layer for visibility changes. Road flood risk is cityRoads, flood "
                "depth is floodDepth, and heat and surface temperature are separate layers. "
                "For show, enable, make visible, or turn on, set visibility to on. For hide, disable, or "
                "turn off, set visibility to off. Use toggle only for an explicit request to flip visibility. "
                "Use workspace for opening a tool. Scenarios is rainfall, Routes is drive, and "
                "Weather Report is weatherReport. Use simulation for a Bengaluru rainfall preset or "
                "a custom intensity and duration, flood-demo for the built-in demo, and stop-simulation "
                "to stop a simulation or demo. Ask for any missing custom simulation settings. "
                "Use weather for a request for actual local conditions, such as whether to carry an umbrella, "
                "not an explanation of what a forecast means. Omit hours and day for current conditions. Use hours "
                "for a duration and day for today or tomorrow. Use eta for remaining active-trip time or distance, "
                "and direction for the next instruction on an active trip. Use route for an actual request to plan "
                "or navigate to a place. Copy the destination and any given origin as exact phrases the user said, "
                "including current-location phrases. If discussing a hypothetical route or missing a destination, "
                "reply or ask a question. For a request for the chance or probability of rain, use weather with "
                "focus rain_probability and a relevant day. The app reports forecast rainfall amounts and tells "
                "the user that a probability percentage is unavailable; never invent one. CityShield supports "
                "weather and routing across India. It looks up places "
                "and fetches weather and route data itself. "
                "Never invent local conditions, distances, directions, or claim a route was set by you."
            )}]},
            "contents": contents,
            "generationConfig": {
                "maxOutputTokens": 768, "temperature": 0.35,
                "responseMimeType": "application/json", "responseSchema": _CX_DECISION_SCHEMA,
            },
        }, timeout=12, retry_transient=True)
        return _conversation_response(ConversationDecision.model_validate_json(text), request)
    except (URLError, TimeoutError, ValueError, KeyError, IndexError, TypeError) as error:
        logger.warning("CX conversation failed (type=%s, status=%s)", type(error).__name__, getattr(error, "code", None))
        return {"status": "unavailable", "reason": "upstream"}
    finally:
        _conversation_slots.release()
