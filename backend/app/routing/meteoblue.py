"""Optional Meteoblue point forecasts and meteogram images for selected places."""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
import logging
from math import isfinite

import requests
from fastapi import HTTPException

from app.core.config import settings

logger = logging.getLogger("uvicorn.error")
FORECAST_URL = "https://my.meteoblue.com/packages/basic-1h"


def _api_key() -> str:
    if settings.METEOBLUE_API_KEY is None:
        raise HTTPException(status_code=503, detail="Point forecasts are not configured on the backend.")
    return settings.METEOBLUE_API_KEY.get_secret_value()


def _get_forecast(latitude: float, longitude: float) -> dict:
    key = _api_key()
    try:
        response = requests.get(FORECAST_URL, params={
            "lat": latitude, "lon": longitude, "tz": "UTC", "format": "json",
            "temperatureUnit": "C", "precipitationUnit": "mm",
            "timeformat": "iso8601", "forecastDays": 5, "apikey": key,
        }, headers={"Accept": "application/json"}, timeout=(5, 20))
        response.raise_for_status()
        payload = response.json()
        section = payload.get("data_1h") if isinstance(payload, dict) else None
        metadata = payload.get("metadata") if isinstance(payload, dict) else None
        if not isinstance(section, dict) or not isinstance(metadata, dict):
            raise ValueError("Meteoblue response did not include hourly forecast data")
        time_values = section.get("time")
        fields = {name: section.get(name) for name in (
            "temperature", "felttemperature", "precipitation", "relativehumidity", "pictocode",
        )}
        if not isinstance(time_values, list) or not time_values or any(
            not isinstance(fields[name], list) or len(fields[name]) != len(time_values)
            for name in fields
        ):
            raise ValueError("Meteoblue hourly forecast arrays are incomplete")
        hours = []
        for index, valid_at in enumerate(time_values):
            values = {name: fields[name][index] for name in fields}
            if not isinstance(valid_at, str) or any(
                not isinstance(value, (int, float)) or isinstance(value, bool) or not isfinite(value)
                for value in values.values()
            ):
                continue
            if values["precipitation"] < 0 or not 0 <= values["relativehumidity"] <= 100:
                continue
            hours.append({
                "valid_at": valid_at,
                "air_temperature_c": float(values["temperature"]),
                "feels_like_c": float(values["felttemperature"]),
                "precipitation_mm": float(values["precipitation"]),
                "relative_humidity_pct": float(values["relativehumidity"]),
                "pictocode": int(values["pictocode"]),
            })
        if len(hours) < 24:
            raise ValueError("Meteoblue returned no usable hourly values")
        return {
            "location": {"latitude": metadata.get("latitude", latitude),
                         "longitude": metadata.get("longitude", longitude)},
            "model_run": metadata.get("modelrun_utc"),
            "model_updated_at": metadata.get("modelrun_updatetime_utc"),
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "limitations": [
                "Air temperature and apparent temperature are forecast estimates, not station observations.",
                "A selected-point forecast does not add spatial detail to the India-wide grid.",
            ],
            "hours": hours,
        }
    except requests.RequestException as exc:
        # Do not log the request URL: Meteoblue credentials are query parameters.
        logger.warning("Meteoblue forecast request failed (status=%s, type=%s)",
                       getattr(getattr(exc, "response", None), "status_code", None), type(exc).__name__)
        raise HTTPException(status_code=502, detail="The point forecast is temporarily unavailable.") from None
    except (ValueError, TypeError, KeyError) as exc:
        logger.warning("Meteoblue forecast response invalid (type=%s)", type(exc).__name__)
        raise HTTPException(status_code=502, detail="The point forecast returned incomplete data.") from None


@lru_cache(maxsize=256)
def get_meteoblue_forecast(latitude: float, longitude: float, cache_window: int) -> dict:
    """Cache one selected-place package response for five minutes."""
    del cache_window
    return _get_forecast(latitude, longitude)
