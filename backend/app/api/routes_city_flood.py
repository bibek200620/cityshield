"""Municipal rainfall screening on a preprocessed terrain and land-cover grid."""
from __future__ import annotations

import gzip
import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query

from app.hydrology.scs_cn import runoff_mm

router = APIRouter()
GRID_PATH = Path(__file__).resolve().parents[1] / "hydrology" / "bengaluru_flood_grid.json.gz"


@lru_cache(maxsize=1)
def load_grid() -> dict:
    with gzip.open(GRID_PATH, "rt", encoding="utf-8") as file:
        return json.load(file)


def screen_values(grid: dict, rainfall_mm: float) -> list[float | None]:
    runoff_by_cn = {
        cn: runoff_mm(rainfall_mm, cn, ia_coefficient=0.2)
        for cn in {cn for _, _, _, groups in grid["cells"] for cn, _ in groups}
    }
    return [
        round(sum(runoff_by_cn[cn] * count for cn, count in groups) / land_count, 2) if land_count else None
        for _, _, land_count, groups in grid["cells"]
    ]


@router.get("/api/flood/city")
def get_city_flood_screen(rainfall_mm: Annotated[float, Query(ge=0, le=500)]) -> dict:
    try:
        grid = load_grid()
    except FileNotFoundError:
        return {"status": "unavailable", "message": "The municipal flood screening dataset is missing."}
    cells = []
    for (cell_id, rings, land_count, groups), score in zip(grid["cells"], screen_values(grid, rainfall_mm)):
        depressed_land = sum(count for _, count in groups)
        cells.append({
            "id": cell_id,
            "rings": rings,
            "screen_mm": score,
            "depressed_land_percent": round(100 * depressed_land / land_count) if land_count else None,
        })

    return {
        "status": "ready",
        "rainfall_mm": rainfall_mm,
        "grid_m": grid["grid_m"],
        "source": "Copernicus DEM GLO-30 and ESA WorldCover 2021",
        "model": "Local runoff on terrain depressions, SCS Curve Number screening",
        "cells": cells,
    }
