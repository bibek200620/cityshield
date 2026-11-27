"""User-submitted India place search via a configurable geocoder."""
from __future__ import annotations

import json
from functools import lru_cache
from math import isfinite
from threading import Lock
from time import monotonic, sleep
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import APIRouter, HTTPException, Query

from app.core.config import settings

router = APIRouter()
_provider_lock = Lock()
_next_provider_call = 0.0
_INDIA_WEST, _INDIA_SOUTH, _INDIA_EAST, _INDIA_NORTH = 68.0, 6.0, 98.0, 38.0


def _limited_provider_get(url: str) -> list[dict]:
    global _next_provider_call
    request = Request(url, headers={
        "User-Agent": "CityShield/0.1 (India weather and routing)",
        "Accept": "application/json",
    })
    with _provider_lock:
        sleep(max(0, _next_provider_call - monotonic()))
        _next_provider_call = monotonic() + 1.1
        with urlopen(request, timeout=8) as response:
            payload = json.load(response)
    if not isinstance(payload, list):
        raise ValueError("Invalid place search response")
    return payload


@lru_cache(maxsize=128)
def _search_cached(provider_url: str, query: str) -> tuple[dict, ...]:
    params = urlencode({
        "q": f"{query}, India",
        "format": "jsonv2",
        "limit": 5,
        "addressdetails": 1,
        "countrycodes": "in",
        "accept-language": "en",
    })
    try:
        payload = _limited_provider_get(f"{provider_url}?{params}")
    except (URLError, TimeoutError, OSError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(503, "Place search is temporarily unavailable.") from exc

    results: list[dict] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        try:
            lat = float(item["lat"])
            lng = float(item["lon"])
            name = str(item["display_name"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if not isfinite(lat) or not isfinite(lng) or not name:
            continue
        if not (_INDIA_SOUTH <= lat <= _INDIA_NORTH and _INDIA_WEST <= lng <= _INDIA_EAST):
            continue
        osm_type = str(item.get("osm_type", "place"))
        osm_id = item.get("osm_id", item.get("place_id", name))
        results.append({
            "id": f"{osm_type}/{osm_id}",
            "name": name,
            "lat": lat,
            "lng": lng,
            "category": str(item.get("type", item.get("class", "place"))),
        })
    return tuple(results)


@router.get("/api/places/search")
def search_places(query: str = Query(min_length=2, max_length=120)) -> dict:
    normalized = " ".join(query.split())
    if len(normalized) < 2:
        raise HTTPException(422, "Enter at least two characters to search.")
    results = _search_cached(settings.PLACE_SEARCH_URL.rstrip("/"), normalized.casefold())
    return {
        "status": "ready",
        "source": "OpenStreetMap Nominatim",
        "attribution": "© OpenStreetMap contributors",
        "results": list(results),
    }
