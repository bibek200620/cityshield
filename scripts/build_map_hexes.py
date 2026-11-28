"""Build clipped Bengaluru hexagons and overlap weights for map display."""
from __future__ import annotations

import json
import math
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Polygon, box, shape
from shapely.ops import transform

PUBLIC_DATA = Path(__file__).resolve().parents[1] / "frontend" / "public" / "data"
CELL_M = 300
SCALES = {"city": 1700, "district": 650}
FINE_RADIUS_M = 300


def polygons(geometry):
    if geometry.geom_type == "Polygon" and not geometry.is_empty:
        yield geometry
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from polygons(part)


def grid_indices(low: float, high: float, step: float) -> range:
    return range(math.floor(low / step), math.ceil(high / step) + 1)


def make_hex_grid(city, radius: int, to_wgs84) -> list:
    """Intersect a flat-top projected hex grid with the municipal boundary and source cells."""
    west, south, east, north = city.bounds
    dx, dy = 1.5 * radius, math.sqrt(3) * radius
    offsets = [(radius * math.cos(math.pi * i / 3), radius * math.sin(math.pi * i / 3)) for i in range(6)]
    grid = []
    for column in grid_indices(west - radius, east + radius, dx):
        x = column * dx
        shift = dy * (column % 2) / 2
        for row in grid_indices(south - dy - shift, north + dy - shift, dy):
            y = row * dy + shift
            interior = city.intersection(Polygon([(x + ox, y + oy) for ox, oy in offsets]))
            if interior.is_empty or interior.area < 1:
                continue
            minx, miny, maxx, maxy = interior.bounds
            overlaps = []
            for i in grid_indices(minx, maxx, CELL_M):
                for j in grid_indices(miny, maxy, CELL_M):
                    cell = box(i * CELL_M, j * CELL_M, (i + 1) * CELL_M, (j + 1) * CELL_M)
                    area = round(interior.intersection(cell).area)
                    if area:
                        overlaps.append([f"{i}:{j}", area])

            shapes = []
            for part in polygons(transform(to_wgs84, interior)):
                rings = (part.exterior, *part.interiors)
                shapes.append([[[round(lng, 6), round(lat, 6)] for lng, lat in ring.coords] for ring in rings])
            if overlaps and shapes:
                grid.append({"shapes": shapes, "overlaps": overlaps})
    return grid


def main() -> None:
    crs = "EPSG:32643"
    to_utm = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
    geometry = json.loads((PUBLIC_DATA / "bengaluru-boundary.geojson").read_text())["geometry"]
    city = transform(to_utm, shape(geometry)).buffer(0)
    grids = {name: make_hex_grid(city, radius, to_wgs84) for name, radius in SCALES.items()}
    (PUBLIC_DATA / "bengaluru-hexes.json").write_text(json.dumps(grids, separators=(",", ":")) + "\n")
    fine = make_hex_grid(city, FINE_RADIUS_M, to_wgs84)
    (PUBLIC_DATA / "bengaluru-hexes-fine.json").write_text(json.dumps(fine, separators=(",", ":")) + "\n")
    print({**{name: len(grid) for name, grid in grids.items()}, "cells": len(fine)})


if __name__ == "__main__":
    main()
