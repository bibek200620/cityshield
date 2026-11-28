"""FastAPI application entrypoint."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    routes_assistant,
    routes_backtest,
    routes_city_flood,
    routes_driving,
    routes_flood_history,
    routes_explain,
    routes_infra,
    routes_heat,
    routes_exposure,
    routes_places,
    routes_route,
    routes_scenarios,
    routes_simulate,
    routes_weather,
    ws_live,
)
from app.core.config import settings
from app.scenarios.cache import cache

@asynccontextmanager
async def lifespan(app: FastAPI):
    cache.startup()
    yield


app = FastAPI(
    title="India Weather & Routing with Bengaluru Risk Research",
    description=(
        "User-entered rainfall scenarios drive a simplified SCS-CN/physics/GNN flood simulation. "
        "Optional single-scene Landsat LST and common-grid exposure endpoints are provided when "
        "compatible local scene/model artifacts are available. This is not an official warning service."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes_simulate.router)
app.include_router(routes_city_flood.router)
app.include_router(routes_driving.router)
app.include_router(routes_flood_history.router)
app.include_router(routes_places.router)
app.include_router(routes_scenarios.router)
app.include_router(routes_route.router)
app.include_router(routes_infra.router)
app.include_router(routes_heat.router)
app.include_router(routes_exposure.router)
app.include_router(routes_backtest.router)
app.include_router(routes_explain.router)
app.include_router(routes_weather.router)
app.include_router(routes_assistant.router)
app.include_router(ws_live.router)


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "pilot_mode": settings.PILOT_MODE,
        "model_checkpoint_loaded": cache.model_loaded_from_checkpoint,
    }
