import numpy as np
from fastapi.testclient import TestClient

from app.api import routes_city_flood
from app.hydrology.build_city_flood import depression_depth
from app.main import app


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
