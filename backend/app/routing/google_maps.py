"""Selected-location weather, air quality, and mapped facilities.

Credentials stay on the server. Callers receive only the requested data and
must retain the explicit distinction between forecasts, modeled conditions,
and mapped place listings.
"""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
import logging
from math import isfinite
from time import time
from typing import Any

import requests
from fastapi import HTTPException

from app.core.config import settings

logger = logging.getLogger("uvicorn.error")
WEATHER_BASE = "https://weather.googleapis.com/v1"
AIR_QUALITY_URL = "https://airquality.googleapis.com/v1/currentConditions:lookup"
PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby"
MAX_FORECAST_HOURS = 120
FORECAST_PAGE_SIZE = 24


def _api_key() -> str:
    if settings.GOOGLE_MAPS_API_KEY is None:
        raise HTTPException(status_code=503, detail="Location weather services are not configured.")
    return settings.GOOGLE_MAPS_API_KEY.get_secret_value()


def _number(value: Any) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not isfinite(value):
        return None
    return float(value)


def _degrees(value: Any) -> float | None:
    if not isinstance(value, dict):
        return None
    return _number(value.get("degrees"))


def _quantity(value: Any) -> float | None:
    if not isinstance(value, dict):
        return None
    return _number(value.get("quantity"))


def _request_json(method: str, url: str, *, params: dict | None = None,
                  body: dict | None = None, headers: dict | None = None) -> dict:
    try:
        response = requests.request(method, url, params=params, json=body, headers=headers, timeout=(4, 12))
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("The response was not an object")
        return payload
    except requests.RequestException as exc:
        # Never log the request URL or upstream response body: both can contain
        # credentials and untrusted diagnostic text.
        logger.warning("Google location request failed (status=%s, type=%s)",
                       getattr(getattr(exc, "response", None), "status_code", None), type(exc).__name__)
        raise HTTPException(status_code=502, detail="Location data is temporarily unavailable.") from None
    except (ValueError, TypeError) as exc:
        logger.warning("Google location response invalid (type=%s)", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Location data returned an invalid response.") from None


def _forecast_hour(item: Any) -> dict | None:
    if not isinstance(item, dict):
        return None
    interval = item.get("interval")
    start = interval.get("startTime") if isinstance(interval, dict) else None
    temperature = _degrees(item.get("temperature"))
    feels_like = _degrees(item.get("feelsLikeTemperature"))
    humidity = _number(item.get("relativeHumidity"))
    if not isinstance(start, str) or temperature is None or feels_like is None:
        return None
    if humidity is not None and not 0 <= humidity <= 100:
        return None
    precipitation = item.get("precipitation")
    probability = precipitation.get("probability") if isinstance(precipitation, dict) else None
    wind = item.get("wind")
    wind_speed = wind.get("speed") if isinstance(wind, dict) else None
    condition = item.get("weatherCondition")
    description = condition.get("description") if isinstance(condition, dict) else None
    return {
        "valid_at": start,
        "air_temperature_c": temperature,
        "feels_like_c": feels_like,
        "wet_bulb_c": _degrees(item.get("wetBulbTemperature")),
        "precipitation_mm": _quantity(precipitation.get("qpf") if isinstance(precipitation, dict) else None) or 0.0,
        "precipitation_probability_pct": _number(probability.get("percent")) if isinstance(probability, dict) else None,
        "relative_humidity_pct": humidity,
        "wind_speed_kmh": _number(wind_speed.get("value")) if isinstance(wind_speed, dict) else None,
        "uv_index": _number(item.get("uvIndex")),
        "condition": description.get("text") if isinstance(description, dict) else None,
    }


def _load_weather_forecast(latitude: float, longitude: float) -> dict:
    key = _api_key()
    location = {"latitude": latitude, "longitude": longitude}
    current = _request_json("GET", f"{WEATHER_BASE}/currentConditions:lookup", params={
        "key": key, "location.latitude": latitude, "location.longitude": longitude,
    })
    hours: list[dict] = []
    page_token: str | None = None
    for _ in range(MAX_FORECAST_HOURS // FORECAST_PAGE_SIZE):
        params: dict[str, Any] = {
            "key": key,
            "location.latitude": latitude,
            "location.longitude": longitude,
            "pageSize": FORECAST_PAGE_SIZE,
        }
        if page_token:
            params["pageToken"] = page_token
        page = _request_json("GET", f"{WEATHER_BASE}/forecast/hours:lookup", params=params)
        records = page.get("forecastHours")
        if not isinstance(records, list):
            raise HTTPException(status_code=502, detail="The hourly location forecast is incomplete.")
        hours.extend(value for item in records if (value := _forecast_hour(item)) is not None)
        page_token = page.get("nextPageToken") if isinstance(page.get("nextPageToken"), str) else None
        if not page_token or len(hours) >= MAX_FORECAST_HOURS:
            break
    if not hours:
        raise HTTPException(status_code=502, detail="The hourly location forecast is incomplete.")

    condition = current.get("weatherCondition")
    description = condition.get("description") if isinstance(condition, dict) else None
    wind = current.get("wind")
    speed = wind.get("speed") if isinstance(wind, dict) else None
    precip = current.get("precipitation")
    current_metrics = {
        "valid_at": current.get("currentTime"),
        "air_temperature_c": _degrees(current.get("temperature")),
        "feels_like_c": _degrees(current.get("feelsLikeTemperature")),
        "heat_index_c": _degrees(current.get("heatIndex")),
        "relative_humidity_pct": _number(current.get("relativeHumidity")),
        "wind_speed_kmh": _number(speed.get("value")) if isinstance(speed, dict) else None,
        "uv_index": _number(current.get("uvIndex")),
        "precipitation_1h_mm": _quantity(precip.get("qpf")) if isinstance(precip, dict) else None,
        "condition": description.get("text") if isinstance(description, dict) else None,
    }
    if current_metrics["air_temperature_c"] is None:
        raise HTTPException(status_code=502, detail="Current location conditions are incomplete.")
    return {
        "location": location,
        "model_run": None,
        "model_updated_at": None,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "current": current_metrics,
        "hours": hours[:MAX_FORECAST_HOURS],
        "limitations": [
            "Forecasts are model output and can differ from station measurements.",
            "This selected-point forecast does not replace the shared India-wide grid.",
            "Wet-bulb temperature is not WBGT; WBGT is not calculated from these fields.",
        ],
    }


@lru_cache(maxsize=256)
def get_point_weather(latitude: float, longitude: float, cache_window: int) -> dict:
    del cache_window
    return _load_weather_forecast(latitude, longitude)


def _load_air_quality(latitude: float, longitude: float) -> dict:
    key = _api_key()
    payload = _request_json("POST", AIR_QUALITY_URL, params={"key": key}, body={
        "location": {"latitude": latitude, "longitude": longitude},
        "universalAqi": True,
        "extraComputations": ["LOCAL_AQI", "POLLUTANT_CONCENTRATION"],
        "languageCode": "en",
    }, headers={"Content-Type": "application/json"})
    indexes = payload.get("indexes") if isinstance(payload.get("indexes"), list) else []
    pollutants = payload.get("pollutants") if isinstance(payload.get("pollutants"), list) else []
    return {
        "status": "ready" if indexes else "unavailable",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "valid_at": payload.get("dateTime"),
        "indexes": [{
            "name": item.get("displayName"),
            "value": _number(item.get("aqi")),
            "category": item.get("category"),
            "dominant_pollutant": item.get("dominantPollutant"),
        } for item in indexes if isinstance(item, dict) and _number(item.get("aqi")) is not None],
        "pollutants": [{
            "name": item.get("displayName"),
            "value": _number((item.get("concentration") or {}).get("value"))
            if isinstance(item.get("concentration"), dict) else None,
            "unit": (item.get("concentration") or {}).get("units")
            if isinstance(item.get("concentration"), dict) else None,
        } for item in pollutants if isinstance(item, dict)],
        "limitations": ["Air-quality values are location estimates, not a substitute for a nearby regulatory monitor."],
    }


@lru_cache(maxsize=512)
def get_point_air_quality(latitude: float, longitude: float, cache_window: int) -> dict:
    del cache_window
    return _load_air_quality(latitude, longitude)


def _load_nearby_facilities(latitude: float, longitude: float, radius_m: int) -> dict:
    key = _api_key()
    response = _request_json("POST", PLACES_NEARBY_URL, headers={
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.primaryType,places.googleMapsUri",
    }, body={
        "includedTypes": ["hospital", "fire_station", "police", "community_center"],
        "maxResultCount": 20,
        "rankPreference": "DISTANCE",
        "locationRestriction": {
            "circle": {"center": {"latitude": latitude, "longitude": longitude}, "radius": radius_m},
        },
    })
    places = response.get("places") if isinstance(response.get("places"), list) else []
    results = []
    for place in places:
        if not isinstance(place, dict):
            continue
        location = place.get("location")
        name = place.get("displayName")
        if not isinstance(location, dict) or not isinstance(name, dict):
            continue
        lat, lng = _number(location.get("latitude")), _number(location.get("longitude"))
        label = name.get("text")
        if lat is None or lng is None or not isinstance(label, str) or not label.strip():
            continue
        results.append({
            "id": place.get("id"), "name": label.strip(),
            "category": place.get("primaryType"), "latitude": lat, "longitude": lng,
            "map_url": place.get("googleMapsUri"),
            "status": "mapped_listing_unverified",
        })
    return {
        "status": "ready" if results else "empty",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "results": results,
        "limitations": [
            "Listings are map records; operating status and emergency capacity are not verified.",
            "No cooling-centre inventory or availability feed is connected.",
        ],
    }


def get_nearby_facilities(latitude: float, longitude: float, radius_m: int) -> dict:
    return _load_nearby_facilities(latitude, longitude, radius_m)
