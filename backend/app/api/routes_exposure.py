"""Common-grid overlay of independent flood and heat outputs."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from app.api.routes_heat import build_heat_workflow
from app.geo.exposure import COMMON_CRS, COMMON_GRID_RESOLUTION_M, FLOOD_ELEVATED_THRESHOLD_M, combine_exposure_cells
from app.scenarios.cache import cache

router = APIRouter()


class ExposureCell(BaseModel):
    grid_id: str
    grid_i: int
    grid_j: int
    lng: float
    lat: float
    flood_depth_m: float | None
    flood_elevated: bool | None
    lst_c: float | None
    heat_elevated: bool | None
    both_elevated: bool


class ExposureResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: Literal["ready", "unavailable"]
    message: str
    scenario_id: str
    grid_crs: str
    grid_resolution_m: int
    flood_elevated_threshold_m: float
    heat_elevated_definition: str
    cells: list[ExposureCell]
    limitations: list[str]


@router.get("/api/exposure/{scenario_id}", response_model=ExposureResponse)
def get_combined_exposure(scenario_id: str) -> ExposureResponse:
    scenario = cache.get(scenario_id)
    if scenario is None:
        raise HTTPException(status_code=404, detail=f"Unknown scenario_id '{scenario_id}'")

    heat = build_heat_workflow(include_explanation=False)
    limitations = [
        "Flood depth is a simulated node estimate snapped to the common grid; it is not a verified street-level water depth.",
        "The flood GNN is trained against simplified physics outputs; validation against observed flood events is unavailable.",
        "Heat is a single-scene remotely sensed modelled LST pattern, not air temperature or a heatwave forecast.",
        "Both elevated means the independent flood and relative heat criteria are each met in one aligned grid cell; no compound probability is estimated.",
    ]
    if heat.status != "ready":
        return ExposureResponse(
            status="unavailable",
            message="Combined exposure unavailable until both flood simulation and compatible Landsat heat outputs are available. " + heat.message,
            scenario_id=scenario_id,
            grid_crs=COMMON_CRS,
            grid_resolution_m=COMMON_GRID_RESOLUTION_M,
            flood_elevated_threshold_m=FLOOD_ELEVATED_THRESHOLD_M,
            heat_elevated_definition=heat.hotspot_definition,
            cells=[],
            limitations=limitations,
        )

    flood_points = [
        {
            "lng": cache.drainage_graph.nodes[node_id]["lng"],
            "lat": cache.drainage_graph.nodes[node_id]["lat"],
            "depth_m_mean": depth,
        }
        for node_id, depth in scenario.node_depth_mean.items()
    ]
    cells = combine_exposure_cells(flood_points, [cell.model_dump() for cell in heat.cells])
    both_count = sum(cell["both_elevated"] for cell in cells)
    message = (
        f"Cells meeting both elevation thresholds: {both_count}."
        if both_count
        else "No cells meet both elevation thresholds for this scenario and acquisition."
    )
    return ExposureResponse(
        status="ready",
        message=message,
        scenario_id=scenario_id,
        grid_crs=COMMON_CRS,
        grid_resolution_m=COMMON_GRID_RESOLUTION_M,
        flood_elevated_threshold_m=FLOOD_ELEVATED_THRESHOLD_M,
        heat_elevated_definition=heat.hotspot_definition,
        cells=cells,
        limitations=limitations,
    )
