import type { Position } from "geojson";
import type { MapGeoJSONFeature } from "maplibre-gl";
import type { CityFloodCell } from "../api/client";

type Point = [number, number];
type Cell = { cell: CityFloodCell; bounds: [number, number, number, number] };
export type RoadRunoff = { path: [Point, Point]; runoffMm: number; name: string };

export const ROAD_SCREEN_MIN_ZOOM = 9;
const bucketSize = 0.005;
const epsilon = 1e-8;

function boundsFor(a: Position, b: Position): Cell["bounds"] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

function* buckets([west, south, east, north]: Cell["bounds"]) {
  for (let x = Math.floor(west / bucketSize); x <= Math.floor(east / bucketSize); x++) {
    for (let y = Math.floor(south / bucketSize); y <= Math.floor(north / bucketSize); y++) yield `${x}:${y}`;
  }
}

function insidePolygon([x, y]: Point, rings: CityFloodCell["rings"]) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1];
      const [bx, by] = ring[i];
      if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
    }
  }
  return inside;
}

function clipSegment(a: Position, b: Position, rings: CityFloodCell["rings"]): [Point, Point][] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const at = (fraction: number): Point => [a[0] + fraction * dx, a[1] + fraction * dy];
  const cuts = [0, 1];
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [x, y] = ring[i - 1];
      const rx = ring[i][0] - x;
      const ry = ring[i][1] - y;
      const denominator = dx * ry - dy * rx;
      if (Math.abs(denominator) < 1e-15) continue;
      const t = ((x - a[0]) * ry - (y - a[1]) * rx) / denominator;
      const u = ((x - a[0]) * dy - (y - a[1]) * dx) / denominator;
      if (t > epsilon && t < 1 - epsilon && u >= -epsilon && u <= 1 + epsilon) cuts.push(t);
    }
  }
  cuts.sort((left, right) => left - right);
  const covered: [Point, Point][] = [];
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1];
    const to = cuts[i];
    if (to - from > epsilon && insidePolygon(at((from + to) / 2), rings)) covered.push([at(from), at(to)]);
  }
  return covered;
}

export function createRoadRunoffScreen(cells: CityFloodCell[]) {
  const grid = new Map<string, Cell[]>();
  for (const cell of cells) {
    if (cell.screen_mm === null || cell.screen_mm < 1 || !cell.rings[0]?.length) continue;
    const bounds: Cell["bounds"] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lng, lat] of cell.rings[0]) {
      bounds[0] = Math.min(bounds[0], lng);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lng);
      bounds[3] = Math.max(bounds[3], lat);
    }
    const entry = { cell, bounds };
    for (const bucket of buckets(bounds)) {
      const entries = grid.get(bucket);
      if (entries) entries.push(entry);
      else grid.set(bucket, [entry]);
    }
  }

  return (features: MapGeoJSONFeature[]): RoadRunoff[] => {
    if (grid.size === 0) return [];
    const result = new Map<string, RoadRunoff>();
    for (const { geometry, properties } of features) {
      if (properties.is_bridge || properties.is_tunnel) continue;
      const lines = geometry.type === "LineString" ? [geometry.coordinates]
        : geometry.type === "MultiLineString" ? geometry.coordinates : [];
      const name = typeof properties.name === "string" ? properties.name : "Mapped road";
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1];
          const b = line[i];
          if (a[0] === b[0] && a[1] === b[1]) continue;
          const bounds = boundsFor(a, b);
          const visited = new Set<CityFloodCell>();
          for (const bucket of buckets(bounds)) {
            for (const entry of grid.get(bucket) ?? []) {
              const { cell, bounds: [west, south, east, north] } = entry;
              if (visited.has(cell) || bounds[0] > east || bounds[1] > north || bounds[2] < west || bounds[3] < south) continue;
              visited.add(cell);
              for (const path of clipSegment(a, b, cell.rings)) {
                const id = path.map((point) => point.map((value) => value.toFixed(6)).join(",")).sort().join(":");
                const runoffMm = cell.screen_mm ?? 0;
                if ((result.get(id)?.runoffMm ?? 0) < runoffMm) result.set(id, { path, runoffMm, name });
              }
            }
          }
        }
      }
    }
    return [...result.values()];
  };
}
