from datetime import datetime, timedelta, timezone

import numpy as np
from fastapi.testclient import TestClient

from app.api import routes_city_flood, routes_weather
from app.hydrology.build_city_flood import depression_depth
from app.main import app
from app.routing import conditions


def test_terrain_depression_respects_the_lowest_spill_outlet():
    elevations = np.array([[5, 5, 5], [5, 1, 3], [5, 5, 5]], dtype=float)
    expected = np.zeros_like(elevations)
    expected[1, 1] = 2
    np.testing.assert_array_equal(depression_depth(elevations), expected)


def test_city_flood_endpoint_covers_the_city_and_responds_to_rainfall():
    client = TestClient(app)
    dry = client.get("/api/flood/city", params={"rainfall_mm": 0}).json()
    wet = client.get("/api/flood/city", params={"rainfall_mm": 90}).json()
    assert dry["status"] == wet["status"] == "ready"
    assert wet["grid_m"] == 300
    assert len(wet["cells"]) == len({cell["id"] for cell in wet["cells"]}) > 8000
    points = [point for cell in wet["cells"] for point in cell["rings"][0]]
    assert min(p[0] for p in points) < 77.47 and max(p[0] for p in points) > 77.77
    assert min(p[1] for p in points) < 12.85 and max(p[1] for p in points) > 13.13
    assert all(cell["screen_mm"] in {0, None} for cell in dry["cells"])
    assert any(cell["screen_mm"] and cell["screen_mm"] > 0 for cell in wet["cells"])
    assert any(cell["screen_mm"] is None for cell in wet["cells"])
    assert client.get("/api/flood/city", params={"rainfall_mm": -1}).status_code == 422


def test_city_flood_without_grid_reports_unavailable(monkeypatch, tmp_path):
    routes_city_flood.load_grid.cache_clear()
    monkeypatch.setattr(routes_city_flood, "GRID_PATH", tmp_path / "missing.json.gz")
    response = TestClient(app).get("/api/flood/city", params={"rainfall_mm": 90})
    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"


def test_road_runoff_forecast_uses_local_rain_totals_and_excludes_dry_cells(monkeypatch):
    def cell(name, lng):
        ring = [[lng, 12.97], [lng + 0.002, 12.97], [lng + 0.002, 12.972], [lng, 12.972], [lng, 12.97]]
        return [name, [ring], 1, [[92, 1]]]

    grid = {"grid_m": 300, "cells": [cell("west", 77.51), cell("east", 77.71)]}
    through = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    forecasts = [
        {"forecast_through": through, "recent_rain_mm": recent, "upcoming_rain_mm": upcoming,
         "provenance": {"grid_cell_center": {"latitude": 12.97, "longitude": lng}}}
        for recent, upcoming, lng in [(6, 5, 77.51), (0, 0, 77.71)]
    ]
    monkeypatch.setattr(routes_weather, "get_alert_weather", lambda: forecasts)
    monkeypatch.setattr(routes_weather, "load_grid", lambda: grid)
    monkeypatch.setattr(conditions, "load_grid", lambda: grid)
    conditions.nearest_forecast_points.cache_clear()
    try:
        result = TestClient(app).get("/api/weather/road-runoff").json()
    finally:
        conditions.nearest_forecast_points.cache_clear()
    assert result["status"] == "ready"
    assert result["forecast_points"] == 2
    assert result["forecast_through"] == through
    assert result["cells"] == [{"id": "west", "rings": grid["cells"][0][1], "screen_mm": 1.51}]


def test_road_runoff_forecast_does_not_treat_stale_weather_as_dry(monkeypatch):
    through = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    monkeypatch.setattr(routes_weather, "get_alert_weather", lambda: [{"forecast_through": through, "is_stale": True}])
    response = TestClient(app).get("/api/weather/road-runoff")
    assert response.status_code == 200
    assert response.json()["status"] == "unavailable"
