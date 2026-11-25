from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient
from rasterio.warp import transform

from app.api import routes_exposure, routes_heat
from app.geo.exposure import COMMON_GRID_RESOLUTION_M
from app.main import app


def _grid_center(i: int, j: int) -> tuple[float, float]:
    east = i * COMMON_GRID_RESOLUTION_M + COMMON_GRID_RESOLUTION_M / 2
    north = j * COMMON_GRID_RESOLUTION_M + COMMON_GRID_RESOLUTION_M / 2
    lng, lat = transform("EPSG:32643", "EPSG:4326", [east], [north])
    return lng[0], lat[0]


def _heat_response(*, status: str, cells: list[routes_heat.HeatCell] | None = None):
    return routes_heat.HeatWorkflowResponse(
        status=status,
        message="Test Landsat LST fixture; not air temperature or a forecast.",
        source="Synthetic test fixture",
        provenance_class="remotely_sensed",
        output_kind="Modelled land-surface temperature (LST)",
        hotspot_definition="Relative top decile in test fixture.",
        cells=cells or [],
        explanation_status="unavailable",
        explanation_message="Test fixture has no explanation artifact.",
        limitations=["Synthetic test fixture; no real observations."],
    )


def _install_cache(monkeypatch, scenario_id: str, depths: dict[str, float], locations: dict[str, tuple[float, float]]):
    scenario = SimpleNamespace(node_depth_mean=depths)
    graph = SimpleNamespace(nodes={
        node_id: {"lng": location[0], "lat": location[1]}
        for node_id, location in locations.items()
    })
    fake_cache = SimpleNamespace(
        get=lambda requested: scenario if requested == scenario_id else None,
        drainage_graph=graph,
    )
    monkeypatch.setattr(routes_exposure, "cache", fake_cache)


def test_exposure_api_returns_separate_values_and_marks_both_only_at_both_thresholds(monkeypatch):
    high = _grid_center(12466, 47633)
    low = _grid_center(12467, 47633)
    heat_only = _grid_center(12468, 47633)
    _install_cache(
        monkeypatch,
        "fixture-scenario",
        {"high": 0.15, "low": 0.149},
        {"high": high, "low": low},
    )
    heat = _heat_response(status="ready", cells=[
        routes_heat.HeatCell(grid_id=f"heat-{index}", grid_row=0, grid_col=index, lng=point[0], lat=point[1], temperature_c=35.0, hotspot=True)
        for index, point in enumerate((high, low, heat_only))
    ])
    monkeypatch.setattr(routes_exposure, "build_heat_workflow", lambda *, include_explanation: heat)

    response = TestClient(app).get("/api/exposure/fixture-scenario")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    cells = {(cell["grid_i"], cell["grid_j"]): cell for cell in body["cells"]}
    high_cell = cells[(12466, 47633)]
    low_cell = cells[(12467, 47633)]
    heat_only_cell = cells[(12468, 47633)]
    assert high_cell["flood_depth_m"] == 0.15
    assert high_cell["flood_elevated"] is True
    assert high_cell["lst_c"] == 35.0
    assert high_cell["heat_elevated"] is True
    assert high_cell["both_elevated"] is True
    assert low_cell["flood_elevated"] is False
    assert low_cell["heat_elevated"] is True
    assert low_cell["both_elevated"] is False
    assert heat_only_cell["flood_depth_m"] is None
    assert heat_only_cell["flood_elevated"] is None
    assert heat_only_cell["both_elevated"] is False
    assert "compound probability" in " ".join(body["limitations"])
    assert "probability" not in body


def test_exposure_api_reports_unavailable_heat_and_unknown_scenario(monkeypatch):
    point = _grid_center(12466, 47633)
    _install_cache(monkeypatch, "fixture-scenario", {"high": 0.3}, {"high": point})
    heat = _heat_response(status="unavailable")
    monkeypatch.setattr(routes_exposure, "build_heat_workflow", lambda *, include_explanation: heat)

    client = TestClient(app)
    unavailable = client.get("/api/exposure/fixture-scenario")
    unknown = client.get("/api/exposure/missing-scenario")

    assert unavailable.status_code == 200
    assert unavailable.json()["status"] == "unavailable"
    assert unavailable.json()["cells"] == []
    assert "not air temperature or a heatwave forecast" in " ".join(unavailable.json()["limitations"])
    assert unknown.status_code == 404
