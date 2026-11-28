"""India-wide forecast grid and selected-point weather endpoints."""
from datetime import datetime, timezone
from time import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.api.routes_city_flood import load_grid, screen_values
from app.core.config import settings
from app.routing.conditions import (
    RUNOFF_THRESHOLD_MM, WEATHER_LOCATION, get_alert_weather, get_two_day_forecast,
    get_weather, nearest_forecast_points,
)
from app.routing.air_quality import get_air_quality
from app.routing.meteoblue import get_meteoblue_forecast
from app.routing.noaa_gfs import get_national_weather_grid

router = APIRouter()


def _public_forecast_payload(value: Any) -> Any:
    """Keep forecast API responses independent of upstream identity fields."""
    if isinstance(value, dict):
        return {
            key: _public_forecast_payload(item)
            for key, item in value.items()
            if key.casefold() not in {"provider", "providers", "source", "endpoint", "attribution"}
        }
    if isinstance(value, list):
        return [_public_forecast_payload(item) for item in value]
    return value


class WeatherGridLocation(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    lat: float = Field(ge=6, le=38)
    lng: float = Field(ge=68, le=98)


class WeatherGridRequest(BaseModel):
    locations: list[WeatherGridLocation] = Field(min_length=1, max_length=1200)


@router.get("/api/weather/nowcast")
def get_weather_nowcast(latitude: float = Query(WEATHER_LOCATION["latitude"], ge=6, le=38),
                        longitude: float = Query(WEATHER_LOCATION["longitude"], ge=68, le=98)) -> dict:
    return _public_forecast_payload(get_weather(latitude, longitude))


@router.get("/api/weather/report")
def get_weather_report(latitude: float = Query(WEATHER_LOCATION["latitude"], ge=6, le=38),
                       longitude: float = Query(WEATHER_LOCATION["longitude"], ge=68, le=98)) -> dict:
    return _public_forecast_payload(get_two_day_forecast(latitude, longitude))


@router.get("/api/weather/road-runoff")
def get_road_runoff_forecast() -> dict:
    forecasts = get_alert_weather()
    now = datetime.now(timezone.utc)
    current = [
        weather for weather in forecasts
        if not weather.get("is_stale") and datetime.fromisoformat(weather["forecast_through"]) > now
    ]
    if not current:
        return {"status": "unavailable", "message": "A current Bengaluru rainfall forecast is unavailable."}

    try:
        grid = load_grid()
    except FileNotFoundError:
        return {"status": "unavailable", "message": "The Bengaluru runoff grid is unavailable."}

    rain_by_point = {}
    for weather in current:
        center = weather["provenance"]["grid_cell_center"]
        rain_by_point[center["longitude"], center["latitude"]] = round(
            weather["recent_rain_mm"] + weather["upcoming_rain_mm"], 2,
        )
    rainfall = tuple(rain_by_point.values())
    zones = nearest_forecast_points(tuple(rain_by_point)) if len(rainfall) > 1 else (0,) * len(grid["cells"])
    values = {rain: screen_values(grid, rain) for rain in set(rainfall)}
    cells = []
    for index, ((cell_id, rings, *_), zone) in enumerate(zip(grid["cells"], zones)):
        runoff = values[rainfall[zone]][index]
        if runoff is not None and runoff >= RUNOFF_THRESHOLD_MM:
            cells.append({"id": cell_id, "rings": rings, "screen_mm": runoff})

    return {
        "status": "ready",
        "grid_m": grid["grid_m"],
        "forecast_points": len(rainfall),
        "forecast_through": min(weather["forecast_through"] for weather in current),
        "cells": cells,
    }


@router.post("/api/weather/grid")
def get_weather_grid(request: WeatherGridRequest) -> dict:
    points = [location.model_dump() for location in request.locations]
    results, unavailable = get_national_weather_grid(points)
    results = _public_forecast_payload(results)
    status = "unavailable" if not results else "partial" if unavailable else "ready"
    return {
        "status": status,
        "results": results,
        "checked_locations": len(results),
        "unavailable_locations": unavailable,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/api/weather/point-forecast")
def get_selected_location_forecast(
    latitude: float = Query(..., ge=6, le=38),
    longitude: float = Query(..., ge=68, le=98),
) -> dict:
    lat, lng = round(latitude, 4), round(longitude, 4)
    if settings.METEOBLUE_API_KEY is not None:
        forecast = get_meteoblue_forecast(lat, lng, int(time() // 300))
    else:
        fallback = get_two_day_forecast(lat, lng)
        if fallback.get("status") != "ready":
            raise HTTPException(status_code=503, detail=fallback.get("message", "The point forecast is unavailable."))
        provenance = fallback.get("provenance", {})
        forecast = {
            "location": {"latitude": lat, "longitude": lng},
            "model_run": provenance.get("model_run"),
            "model_updated_at": None,
            "retrieved_at": provenance.get("retrieved_at", datetime.now(timezone.utc).isoformat()),
            "hours": [{
                "valid_at": hour["valid_at"],
                "air_temperature_c": hour["air_temperature_c"],
                "feels_like_c": hour["feels_like_c"],
                "precipitation_mm": hour["precipitation_mm"],
                "relative_humidity_pct": hour["relative_humidity_pct"],
            } for hour in fallback.get("hourly_forecast", [])],
            "limitations": [
                "Only the next 48 hourly forecast estimates are available for this location.",
                "Air temperature is a forecast estimate, not a station observation.",
            ],
        }
    return _public_forecast_payload(forecast)


@router.get("/api/weather/air-quality")
def get_selected_location_air_quality(
    latitude: float = Query(..., ge=6, le=38),
    longitude: float = Query(..., ge=68, le=98),
) -> dict:
    return _public_forecast_payload(get_air_quality(
        round(latitude, 3), round(longitude, 3), int(time() // 1800),
    ))
