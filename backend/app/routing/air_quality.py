"""Point air-quality estimate from the global atmospheric composition model."""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from math import isfinite

import requests
from fastapi import HTTPException

AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
POLLUTANTS = {
    "pm2_5": ("PM2.5", "µg/m³"),
    "pm10": ("PM10", "µg/m³"),
    "carbon_monoxide": ("Carbon monoxide", "µg/m³"),
    "nitrogen_dioxide": ("Nitrogen dioxide", "µg/m³"),
    "sulphur_dioxide": ("Sulphur dioxide", "µg/m³"),
    "ozone": ("Ozone", "µg/m³"),
}


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        return None
    return float(value)


def _aqi_category(value: float) -> str:
    if value <= 50:
        return "Good"
    if value <= 100:
        return "Moderate"
    if value <= 150:
        return "Unhealthy for sensitive groups"
    if value <= 200:
        return "Unhealthy"
    if value <= 300:
        return "Very unhealthy"
    return "Hazardous"


def _load(latitude: float, longitude: float) -> dict:
    try:
        response = requests.get(AIR_QUALITY_URL, params={
            "latitude": latitude,
            "longitude": longitude,
            "current": ",".join(("us_aqi", *POLLUTANTS)),
            "domains": "cams_global",
            "timezone": "UTC",
        }, headers={"Accept": "application/json"}, timeout=(4, 12))
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError, TypeError) as exc:
        raise HTTPException(503, "Air-quality estimates are temporarily unavailable.") from exc
    current = payload.get("current") if isinstance(payload, dict) else None
    if not isinstance(current, dict):
        raise HTTPException(502, "Air-quality estimates returned incomplete data.")
    aqi = _number(current.get("us_aqi"))
    pollutants = [{
        "name": label,
        "value": _number(current.get(name)),
        "unit": unit,
    } for name, (label, unit) in POLLUTANTS.items() if _number(current.get(name)) is not None]
    limitations = [
        "Air-quality values are atmospheric-model estimates at coarse grid resolution, not readings from a nearby regulatory monitor.",
        "US AQI categories are shown as a common index; this is not an India-specific regulatory AQI or official health advisory.",
        "This request covers only the selected point; the nationwide weather hexes do not contain air-quality values.",
    ]
    indexes = [] if aqi is None else [{
        "name": "US AQI",
        "value": aqi,
        "category": _aqi_category(aqi),
        "dominant_pollutant": None,
    }]
    return {
        "status": "ready" if indexes or pollutants else "empty",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "valid_at": current.get("time") if isinstance(current.get("time"), str) else None,
        "indexes": indexes,
        "pollutants": pollutants,
        "limitations": limitations,
    }


@lru_cache(maxsize=256)
def get_air_quality(latitude: float, longitude: float, cache_window: int) -> dict:
    """Fetch one point every 30 minutes and cache the model response."""
    del cache_window
    return _load(latitude, longitude)
