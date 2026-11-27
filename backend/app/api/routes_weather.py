"""Timestamped India conditions from Open-Meteo weather models."""
from fastapi import APIRouter, Query

from app.routing.conditions import WEATHER_LOCATION, get_two_day_forecast, get_weather

router = APIRouter()


@router.get("/api/weather/nowcast")
def get_weather_nowcast(latitude: float = Query(WEATHER_LOCATION["latitude"], ge=6, le=38),
                        longitude: float = Query(WEATHER_LOCATION["longitude"], ge=68, le=98)) -> dict:
    return get_weather(latitude, longitude)


@router.get("/api/weather/report")
def get_weather_report(latitude: float = Query(WEATHER_LOCATION["latitude"], ge=6, le=38),
                       longitude: float = Query(WEATHER_LOCATION["longitude"], ge=68, le=98)) -> dict:
    return get_two_day_forecast(latitude, longitude)
