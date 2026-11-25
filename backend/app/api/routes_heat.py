"""Single-acquisition Landsat land-surface-temperature workflow."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from app.core.config import settings
from app.heat.landsat import LandsatDataError, load_landsat_scene
from app.heat.model import HeatModelError, load_compatible_model, predict_heat_cells, summarize_heat_shap
from app.heat.train import parse_bbox

router = APIRouter()


class HeatCell(BaseModel):
    grid_id: str
    grid_row: int
    grid_col: int
    lng: float
    lat: float
    temperature_c: float
    hotspot: bool


class HeatWorkflowResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: Literal["ready", "unavailable"]
    message: str
    source: str
    provenance_class: Literal["remotely_sensed"]
    output_kind: str
    scene_id: str | None = None
    acquisition_date: str | None = None
    generated_at_utc: datetime | None = None
    model_version: str | None = None
    crs: str | None = None
    pixel_resolution_m: float | None = None
    hotspot_threshold_c: float | None = None
    hotspot_definition: str
    cells: list[HeatCell] = []
    explanation_status: Literal["available", "unavailable"]
    explanation_message: str
    explanation_sample_pixels: int | None = None
    feature_mean_abs_shap_c: dict[str, float] = {}
    limitations: list[str]


SOURCE = "USGS Landsat Collection 2 Level-2; local scene bundle required"
OUTPUT_KIND = "Modelled land-surface temperature (LST) / urban heat pattern"
LIMITATIONS = [
    "One Landsat acquisition only; this is not a temporal forecast.",
    "LST is not near-surface air temperature or a validated human heatwave forecast.",
    "Predictions are limited to the scene, feature schema and Bellandur pilot extent.",
    "Spatial holdout metrics apply only within the supplied acquisition.",
]


def _unavailable(message: str, *, stack=None) -> HeatWorkflowResponse:
    return HeatWorkflowResponse(
        status="unavailable",
        message=message,
        source=SOURCE,
        provenance_class="remotely_sensed",
        output_kind=OUTPUT_KIND,
        scene_id=stack.scene_id if stack else None,
        acquisition_date=stack.acquisition_date if stack else None,
        crs=stack.crs if stack else None,
        pixel_resolution_m=stack.pixel_resolution_m if stack else None,
        hotspot_definition="Relative top decile of valid predicted LST in this one scene; not an absolute health threshold.",
        explanation_status="unavailable",
        explanation_message="TreeSHAP requires a compatible scene and XGBoost model.",
        limitations=LIMITATIONS,
    )


@router.get("/api/heat", response_model=HeatWorkflowResponse)
def get_heat_workflow() -> HeatWorkflowResponse:
    return build_heat_workflow(include_explanation=True)


def build_heat_workflow(*, include_explanation: bool) -> HeatWorkflowResponse:
    scene_dir = Path(settings.HEAT_SCENE_DIR)
    if not scene_dir.is_dir() or not list(scene_dir.glob("*_SR_B2.TIF")):
        return _unavailable(
            "Heat surface unavailable: provide one compatible Landsat 8/9 Collection 2 Level-2 scene "
            f"under {scene_dir} and train the model with `python -m app.heat.train` from backend/."
        )
    try:
        stack = load_landsat_scene(scene_dir, parse_bbox(settings.HEAT_AOI_BBOX))
    except (LandsatDataError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Landsat scene could not be prepared: {exc}") from exc

    try:
        model, metadata = load_compatible_model(stack, settings.HEAT_MODEL_PATH)
        cells, threshold = predict_heat_cells(stack, model)
    except HeatModelError as exc:
        return _unavailable(
            f"Heat surface unavailable: {exc}. Run `python -m app.heat.train` from backend/ after adding the scene.",
            stack=stack,
        )

    sample_pixels, feature_shap = None, {}
    explanation_message = "Feature explanations are available from the heat endpoint."
    if include_explanation:
        try:
            sample_pixels, feature_shap = summarize_heat_shap(stack, model)
            explanation_message = (
                f"TreeSHAP mean absolute contribution across {sample_pixels} valid pixels. "
                "Values describe the model's predictions and do not establish causal effects."
            )
        except HeatModelError as exc:
            explanation_message = str(exc)

    return HeatWorkflowResponse(
        status="ready",
        message="Single-scene modelled LST surface is available; it is not an air-temperature forecast.",
        source=SOURCE,
        provenance_class="remotely_sensed",
        output_kind=OUTPUT_KIND,
        scene_id=stack.scene_id,
        acquisition_date=stack.acquisition_date,
        generated_at_utc=datetime.now(timezone.utc),
        model_version=metadata["model_version"],
        crs=stack.crs,
        pixel_resolution_m=stack.pixel_resolution_m,
        hotspot_threshold_c=threshold,
        hotspot_definition="Relative top decile of valid predicted LST in this one scene; not an absolute health threshold.",
        cells=cells,
        explanation_status="available" if feature_shap else "unavailable",
        explanation_message=explanation_message,
        explanation_sample_pixels=sample_pixels,
        feature_mean_abs_shap_c=feature_shap,
        limitations=LIMITATIONS,
    )
