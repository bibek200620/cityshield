"""Align independent flood and Landsat outputs on a stable projected grid."""
from __future__ import annotations

from math import floor
from typing import Any

from rasterio.warp import transform

COMMON_CRS = "EPSG:32643"
COMMON_GRID_RESOLUTION_M = 30
FLOOD_ELEVATED_THRESHOLD_M = 0.15
GRID_BOUNDARY_TOLERANCE_M = 1e-6


def _grid_index(x: float, y: float) -> tuple[int, int]:
    def index(coordinate: float) -> int:
        scaled = coordinate / COMMON_GRID_RESOLUTION_M
        boundary = round(scaled)
        # Keep boundary points in the upper cell after a WGS84 round trip.
        if abs(coordinate - boundary * COMMON_GRID_RESOLUTION_M) <= GRID_BOUNDARY_TOLERANCE_M:
            return boundary
        return floor(scaled)

    return index(x), index(y)


def _center(i: int, j: int) -> tuple[float, float]:
    return (
        i * COMMON_GRID_RESOLUTION_M + COMMON_GRID_RESOLUTION_M / 2,
        j * COMMON_GRID_RESOLUTION_M + COMMON_GRID_RESOLUTION_M / 2,
    )


def combine_exposure_cells(
    flood_points: list[dict[str, Any]],
    heat_points: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Snap two independent WGS84 point sets to one fixed UTM 30 m grid.

    Flood node values are aggregated by maximum depth in a cell. Heat values
    are averaged for a cell; the relative-hotspot flag is true if any input
    Landsat pixel assigned to the cell is independently in its top decile.
    A missing hazard remains null and can never set `both_elevated`.
    """
    cells: dict[tuple[int, int], dict[str, Any]] = {}

    for point in flood_points:
        xs, ys = transform("EPSG:4326", COMMON_CRS, [point["lng"]], [point["lat"]])
        key = _grid_index(xs[0], ys[0])
        cell = cells.setdefault(key, {"flood_depths": [], "lst_values": [], "heat_hotspot": False})
        cell["flood_depths"].append(float(point["depth_m_mean"]))

    for point in heat_points:
        xs, ys = transform("EPSG:4326", COMMON_CRS, [point["lng"]], [point["lat"]])
        key = _grid_index(xs[0], ys[0])
        cell = cells.setdefault(key, {"flood_depths": [], "lst_values": [], "heat_hotspot": False})
        cell["lst_values"].append(float(point["temperature_c"]))
        cell["heat_hotspot"] = cell["heat_hotspot"] or bool(point["hotspot"])

    output = []
    for (i, j), values in sorted(cells.items()):
        flood_depth = max(values["flood_depths"]) if values["flood_depths"] else None
        lst = sum(values["lst_values"]) / len(values["lst_values"]) if values["lst_values"] else None
        flood_elevated = flood_depth is not None and flood_depth >= FLOOD_ELEVATED_THRESHOLD_M
        heat_elevated = values["heat_hotspot"] if lst is not None else None
        x, y = _center(i, j)
        lngs, lats = transform(COMMON_CRS, "EPSG:4326", [x], [y])
        output.append({
            "grid_id": f"{COMMON_CRS}:{COMMON_GRID_RESOLUTION_M}:{i}:{j}",
            "grid_i": i,
            "grid_j": j,
            "lng": lngs[0],
            "lat": lats[0],
            "flood_depth_m": flood_depth,
            "flood_elevated": flood_elevated if flood_depth is not None else None,
            "lst_c": lst,
            "heat_elevated": heat_elevated,
            "both_elevated": bool(flood_elevated and heat_elevated is True),
        })
    return output
