"""Generate the ward outlines and 300 m cell overlaps used by the atlas."""
from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape
from shapely.ops import transform
from shapely.strtree import STRtree

from build_map_hexes import PUBLIC_DATA, polygons


FLOOD_GRID = PUBLIC_DATA.parents[2] / "backend/app/hydrology/bengaluru_flood_grid.json.gz"


def intersections(ward, tree: STRtree, keys: list[str]) -> list[list[str | int]]:
    overlaps = []
    for index in tree.query(ward, predicate="intersects"):
        area = round(ward.intersection(tree.geometries[index]).area)
        if area > 0:
            overlaps.append([keys[index], area])
    return sorted(overlaps)


def outline(ward, to_wgs84) -> dict:
    simplified = transform(to_wgs84, ward.simplify(15, preserve_topology=True))
    parts = list(polygons(simplified))
    geometry = mapping(parts[0] if len(parts) == 1 else MultiPolygon(parts))
    geometry["coordinates"] = round_coordinates(geometry["coordinates"])
    return geometry


def round_coordinates(coordinates):
    if isinstance(coordinates[0], (int, float)):
        return [round(value, 6) for value in coordinates]
    return [round_coordinates(part) for part in coordinates]


def build(source: Path) -> dict:
    ward_index = json.loads((PUBLIC_DATA / "bengaluru-wards.json").read_text(encoding="utf-8"))
    features = json.loads(source.read_text(encoding="utf-8"))["features"]
    wards = {}
    for feature in features:
        props = feature["properties"]
        ward_id = f'{props["corporation_id"]}:{props["ward_id"]}'
        if ward_id in wards:
            raise ValueError(f"Duplicate ward ID: {ward_id}")
        wards[ward_id] = feature["geometry"]
    if wards.keys() != {ward["id"] for ward in ward_index}:
        raise ValueError("Boundary IDs do not match the atlas ward index.")

    with gzip.open(FLOOD_GRID, "rt", encoding="utf-8") as stream:
        flood = json.load(stream)
    heat = json.loads((PUBLIC_DATA / "bengaluru-heat.json").read_text())
    to_utm = Transformer.from_crs("EPSG:4326", flood["crs"], always_xy=True).transform
    to_wgs84 = Transformer.from_crs(flood["crs"], "EPSG:4326", always_xy=True).transform
    flood_keys = [key for key, _, _, _ in flood["cells"]]
    flood_tree = STRtree([
        make_valid(transform(to_utm, Polygon(rings[0], rings[1:])))
        for _, rings, _, _ in flood["cells"]
    ])
    heat_keys = sorted({key for _, _, _, key in heat["cells"] if key})
    size = heat["resolution_m"]
    heat_tree = STRtree([
        box(i * size, j * size, (i + 1) * size, (j + 1) * size)
        for i, j in (map(int, key.split(":")) for key in heat_keys)
    ])

    result = {}
    for ward_id, geometry in sorted(wards.items()):
        ward = make_valid(transform(to_utm, shape(geometry)))
        result[ward_id] = {
            "geometry": outline(ward, to_wgs84),
            "area_m2": round(ward.area),
            "flood": intersections(ward, flood_tree, flood_keys),
            "heat": intersections(ward, heat_tree, heat_keys),
        }
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="OpenCity 2025 ward GeoJSON from bharatlas.")
    data = build(parser.parse_args().source)
    (PUBLIC_DATA / "bengaluru-ward-evidence.json").write_text(
        json.dumps(data, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote evidence geometry and grid overlaps for {len(data)} wards.")
