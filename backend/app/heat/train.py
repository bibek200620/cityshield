"""Train the single-scene heat surface model from a local Landsat C2 L2 bundle.

Run from backend/: python -m app.heat.train
"""
from __future__ import annotations

import json
import sys

from app.core.config import settings
from app.heat.landsat import load_landsat_scene
from app.heat.model import train_heat_model


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    parts = tuple(float(part.strip()) for part in value.split(","))
    if len(parts) != 4:
        raise ValueError("HEAT_AOI_BBOX must be west,south,east,north in EPSG:4326")
    west, south, east, north = parts
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("HEAT_AOI_BBOX is not a valid west,south,east,north extent")
    return parts


def main() -> int:
    try:
        stack = load_landsat_scene(settings.HEAT_SCENE_DIR, parse_bbox(settings.HEAT_AOI_BBOX))
        metadata = train_heat_model(stack, settings.HEAT_MODEL_PATH)
    except Exception as exc:
        print(f"Heat model training unavailable: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(metadata, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
