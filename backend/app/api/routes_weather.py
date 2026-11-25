"""Timestamped Bengaluru conditions from Open-Meteo weather models."""
from fastapi import APIRouter

from app.routing.conditions import get_weather

router = APIRouter()


@router.get("/api/weather/nowcast")
def get_weather_nowcast() -> dict:
    return get_weather()
