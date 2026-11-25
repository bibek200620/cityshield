"""Build the Greater Bengaluru flood screening grid from Copernicus and ESA rasters."""
from __future__ import annotations

import gzip
import heapq
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from rasterio.warp import reproject
from pyproj import Transformer
from shapely.geometry import box, mapping, shape
from shapely.ops import transform

DEM_ROOT = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com"
DEM_TILES = tuple(
    f"{DEM_ROOT}/Copernicus_DSM_COG_10_N{lat}_00_E077_00_DEM/Copernicus_DSM_COG_10_N{lat}_00_E077_00_DEM.tif"
    for lat in (12, 13)
)
LAND_COVER = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
    "ESA_WorldCover_10m_2021_v200_N12E075_Map.tif"
)
CRS = "EPSG:32643"
TERRAIN_M = 60
CELL_M = 300
BUFFER_M = 4200
DEPTH_SCREEN_M = 1.0
# Screening assumptions for typical infiltration. No local soil calibration.
CURVE_NUMBERS = {10: 65, 20: 69, 30: 74, 40: 78, 50: 92, 60: 86, 90: 86, 95: 86, 100: 74}
BOUNDARY = Path("../frontend/public/data/bengaluru-boundary.geojson")
OUTPUT = Path(__file__).with_name("bengaluru_flood_grid.json.gz")


def depression_depth(elevation: np.ndarray) -> np.ndarray:
    """Eight-neighbor Priority-Flood, with the buffered raster edge open."""
    if elevation.ndim != 2 or min(elevation.shape) < 3 or not np.isfinite(elevation).all():
        raise ValueError("A continuous finite elevation grid is required")
    height, width = elevation.shape
    filled = elevation.copy()
    visited = np.zeros(elevation.shape, dtype=bool)
    queue = []
    for row in range(height):
        cols = range(width) if row in (0, height - 1) else (0, width - 1)
        for col in cols:
            visited[row, col] = True
            queue.append((float(elevation[row, col]), row, col))
    heapq.heapify(queue)

    while queue:
        level, row, col = heapq.heappop(queue)
        for nr in range(max(0, row - 1), min(height, row + 2)):
            for nc in range(max(0, col - 1), min(width, col + 2)):
                if visited[nr, nc]:
                    continue
                visited[nr, nc] = True
                next_level = max(level, float(elevation[nr, nc]))
                filled[nr, nc] = next_level
                heapq.heappush(queue, (next_level, nr, nc))
    return filled - elevation


def read_projected(url: str, size: tuple[int, int], affine, method: Resampling) -> np.ndarray:
    data = np.full(size, np.nan, dtype=np.float32)
    with rasterio.Env(GDAL_HTTP_TIMEOUT="60", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(url) as source:
            reproject(
                rasterio.band(source, 1), data,
                src_transform=source.transform, src_crs=source.crs, src_nodata=source.nodata,
                dst_transform=affine, dst_crs=CRS, dst_nodata=np.nan, resampling=method,
            )
    return data


def build() -> None:
    project = Transformer.from_crs("EPSG:4326", CRS, always_xy=True).transform
    unproject = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True).transform
    muni = transform(project, shape(json.loads(BOUNDARY.read_text())["geometry"])).buffer(0)
    west, south, east, north = muni.buffer(BUFFER_M).bounds
    west, south = (int(np.floor(value / CELL_M)) * CELL_M for value in (west, south))
    east, north = (int(np.ceil(value / CELL_M)) * CELL_M for value in (east, north))
    size = ((north - south) // TERRAIN_M, (east - west) // TERRAIN_M)
    affine = from_origin(west, north, TERRAIN_M, TERRAIN_M)

    elevation = np.full(size, np.nan, dtype=np.float32)
    for url in DEM_TILES:
        part = read_projected(url, size, affine, Resampling.average)
        np.copyto(elevation, part, where=np.isfinite(part))
    cover = read_projected(LAND_COVER, size, affine, Resampling.mode)
    municipal_mask = geometry_mask([mapping(muni)], out_shape=size, transform=affine, invert=True)
    known_cover = np.isin(cover, [*CURVE_NUMBERS, 80])
    if np.any(municipal_mask & ~known_cover):
        raise ValueError("Unexpected or missing WorldCover classes within the municipal mask")
    is_depression = depression_depth(elevation) >= DEPTH_SCREEN_M
    grouping = CELL_M // TERRAIN_M
    cells = []
    covered_land = 0
    covered_water = 0

    for row in range(0, size[0], grouping):
        for col in range(0, size[1], grouping):
            window = np.s_[row:row + grouping, col:col + grouping]
            mask = municipal_mask[window]
            if not mask.any():
                continue
            cover_tile = cover[window]
            dry_mask = mask & (cover_tile != 80)
            land_count = int(dry_mask.sum())
            covered_land += land_count
            covered_water += int(mask.sum()) - land_count
            depression_tile = is_depression[window] & dry_mask
            groups = [
                [cn, int(np.count_nonzero(depression_tile & (cover_tile == code)))]
                for code, cn in CURVE_NUMBERS.items()
                if np.any(depression_tile & (cover_tile == code))
            ]
            left, top = affine * (col, row)
            cell = muni.intersection(box(left, top - CELL_M, left + CELL_M, top))
            polygons = [cell] if cell.geom_type == "Polygon" else cell.geoms
            for part, polygon in enumerate(polygons):
                if polygon.geom_type != "Polygon" or polygon.is_empty:
                    continue
                coords = mapping(transform(unproject, polygon))["coordinates"]
                rings = [[[round(lng, 6), round(lat, 6)] for lng, lat in ring] for ring in coords]
                cell_id = f"{int(left // CELL_M)}:{int((top - CELL_M) // CELL_M)}:{part}"
                cells.append([cell_id, rings, land_count, groups])

    result = {
        "grid_m": CELL_M, "terrain_m": TERRAIN_M, "crs": CRS,
        "land_samples": covered_land, "permanent_water_samples": covered_water,
        "cells": cells,
    }
    OUTPUT.write_bytes(gzip.compress(json.dumps(result, separators=(",", ":")).encode(), mtime=0))
    print(f"Exported {len(cells)} polygons, {covered_land} land and {covered_water} permanent water samples")


if __name__ == "__main__":
    build()
