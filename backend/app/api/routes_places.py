"""User-submitted India place search via a configurable geocoder."""
from __future__ import annotations

import json
from functools import lru_cache
from math import atan2, cos, isfinite, radians, sin, sqrt
from threading import Lock
from time import monotonic, sleep
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from datetime import datetime, timezone

import requests

from fastapi import APIRouter, HTTPException, Query
from app.core.config import settings

router = APIRouter()
_provider_lock = Lock()
_next_provider_call = 0.0
_INDIA_WEST, _INDIA_SOUTH, _INDIA_EAST, _INDIA_NORTH = 68.0, 6.0, 98.0, 38.0
_PHOTON_SEARCH_URL = "https://photon.komoot.io/api/"
_SEARCH_ERRORS = (URLError, TimeoutError, OSError, ValueError, KeyError, TypeError)


def _limited_provider_json(url: str) -> object:
    global _next_provider_call
    request = Request(url, headers={
        "User-Agent": "CityShield/0.1 (India weather and routing)",
        "Accept": "application/json",
    })
    with _provider_lock:
        sleep(max(0, _next_provider_call - monotonic()))
        _next_provider_call = monotonic() + 1.1
        with urlopen(request, timeout=8) as response:
            return json.load(response)


def _limited_provider_get(url: str) -> list[dict]:
    payload = _limited_provider_json(url)
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
    except _SEARCH_ERRORS as exc:
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


@lru_cache(maxsize=128)
def _search_photon_cached(query: str) -> tuple[dict, ...]:
    params = urlencode({"q": query, "limit": 5, "countrycode": "IN", "lang": "en"})
    payload = _limited_provider_json(f"{_PHOTON_SEARCH_URL}?{params}")
    if not isinstance(payload, dict) or not isinstance(payload.get("features"), list):
        raise ValueError("Invalid Photon search response")
    results = []
    for feature in payload["features"]:
        if not isinstance(feature, dict):
            continue
        properties, geometry = feature.get("properties"), feature.get("geometry")
        if not isinstance(properties, dict) or not isinstance(geometry, dict) or geometry.get("type") != "Point":
            continue
        country = properties.get("countrycode")
        name = properties.get("name")
        osm_type, osm_id = properties.get("osm_type"), properties.get("osm_id")
        if country != "IN" or not isinstance(name, str) or not name.strip() or not osm_type or not osm_id:
            continue
        try:
            lng, lat = map(float, geometry["coordinates"][:2])
        except (KeyError, TypeError, ValueError):
            continue
        if not (_INDIA_SOUTH <= lat <= _INDIA_NORTH and _INDIA_WEST <= lng <= _INDIA_EAST):
            continue
        label = dict.fromkeys(part.strip() for part in (name, properties.get("city"), properties.get("state"))
                              if isinstance(part, str) and part.strip())
        results.append({
            "id": f"{osm_type}/{osm_id}", "name": ", ".join(label), "lat": lat, "lng": lng,
            "category": str(properties.get("osm_value") or geometry["type"]),
        })
    return tuple(results)


@router.get("/api/places/search")
def search_places(query: str = Query(min_length=2, max_length=120)) -> dict:
    normalized = " ".join(query.split())
    if len(normalized) < 2:
        raise HTTPException(422, "Enter at least two characters to search.")
    query_key = normalized.casefold()
    source = "OpenStreetMap Nominatim"
    try:
        results = _search_cached(settings.PLACE_SEARCH_URL.rstrip("/"), query_key)
    except HTTPException as exc:
        if exc.status_code != 503:
            raise
        try:
            results = _search_photon_cached(query_key)
            source = "OpenStreetMap Photon"
        except _SEARCH_ERRORS:
            raise exc from None
    return {
        "status": "ready",
        "source": source,
        "attribution": "© OpenStreetMap contributors",
        "results": list(results),
    }


def _overpass_query(latitude: float, longitude: float, radius_m: int) -> dict:
    """Query a small set of mapped emergency/community amenities on demand."""
    global _next_provider_call
    around = f"around:{radius_m},{latitude:.5f},{longitude:.5f}"
    amenity_values = "hospital|clinic|doctors|fire_station|police|community_centre|shelter"
    query = f"""[out:json][timeout:15];
(
  node({around})[amenity~"{amenity_values}"];
  way({around})[amenity~"{amenity_values}"];
  relation({around})[amenity~"{amenity_values}"];
  node({around})[healthcare~"hospital|clinic"];
  way({around})[healthcare~"hospital|clinic"];
  relation({around})[healthcare~"hospital|clinic"];
);
out center tags 60;"""
    request_headers = {
        "User-Agent": "CityShield/0.1 (India public-safety research map)",
        "Accept": "application/json",
    }
    with _provider_lock:
        sleep(max(0, _next_provider_call - monotonic()))
        _next_provider_call = monotonic() + 1.1
        response = requests.post(
            "https://overpass-api.de/api/interpreter",
            data={"data": query}, headers=request_headers, timeout=(4, 18),
        )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        raise ValueError("Invalid mapped facility response")
    return payload


def _facility_category(tags: dict) -> str:
    amenity = str(tags.get("amenity", ""))
    healthcare = str(tags.get("healthcare", ""))
    categories = {
        "hospital": "hospital", "clinic": "clinic", "doctors": "clinic",
        "fire_station": "fire_station", "police": "police",
        "community_centre": "community_centre", "shelter": "shelter",
    }
    return categories.get(amenity, healthcare if healthcare in {"hospital", "clinic"} else "community")


def _distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    lat1r, lat2r = radians(lat1), radians(lat2)
    dlat, dlng = lat2r - lat1r, radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(lat1r) * cos(lat2r) * sin(dlng / 2) ** 2
    return 6_371_000 * 2 * atan2(sqrt(a), sqrt(max(0.0, 1 - a)))


@lru_cache(maxsize=128)
def _nearby_facilities_cached(latitude: float, longitude: float, radius_m: int, _hour_slot: int) -> tuple[dict, ...]:
    try:
        payload = _overpass_query(latitude, longitude, radius_m)
    except (requests.RequestException, URLError, TimeoutError, OSError, ValueError, TypeError) as exc:
        raise HTTPException(503, "Nearby mapped listings are temporarily unavailable.") from exc
    results = []
    seen: set[str] = set()
    for item in payload["elements"]:
        if not isinstance(item, dict):
            continue
        tags = item.get("tags") if isinstance(item.get("tags"), dict) else {}
        if not (tags.get("name") and (tags.get("amenity") or tags.get("healthcare"))):
            continue
        location = item.get("center") if isinstance(item.get("center"), dict) else item
        try:
            lat, lng = float(location["lat"]), float(location["lon"])
            element_id = f"{item['type']}/{int(item['id'])}"
        except (KeyError, TypeError, ValueError):
            continue
        if not (_INDIA_SOUTH <= lat <= _INDIA_NORTH and _INDIA_WEST <= lng <= _INDIA_EAST):
            continue
        if _distance_m(latitude, longitude, lat, lng) > radius_m or element_id in seen:
            continue
        seen.add(element_id)
        results.append({
            "id": element_id,
            "name": str(tags["name"])[:160],
            "category": _facility_category(tags),
            "latitude": lat,
            "longitude": lng,
            "map_url": f"https://www.openstreetmap.org/{element_id}",
            "status": "mapped_listing_unverified",
        })
        if len(results) >= 60:
            break
    return tuple(results)


@router.get("/api/places/nearby")
def nearby_facilities(
    latitude: float = Query(..., ge=6, le=38),
    longitude: float = Query(..., ge=68, le=98),
    radius_m: int = Query(3000, ge=250, le=10000),
) -> dict:
    lat, lng = round(latitude, 5), round(longitude, 5)
    results = list(_nearby_facilities_cached(lat, lng, radius_m, int(monotonic() // 3600)))
    return {
        "status": "ready" if results else "empty",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "results": results,
        "limitations": [
            "Listings are mapped community data and may be incomplete, closed, or out of date.",
            "A listing does not verify emergency capacity, accessibility, operational status, or cooling-centre availability.",
            "No public report or route is marked verified or safe based on these listings.",
        ],
    }
