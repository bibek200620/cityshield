type Ring = [number, number][];

export interface HexCell {
  shapes: Ring[][];
  overlaps: [gridKey: string, squareMeters: number][];
}

export type MapDetail = "city" | "district" | "cells";
export type HexGrids = Record<Exclude<MapDetail, "cells">, HexCell[]>;
export interface HexSummary {
  rings: Ring[];
  value: number | null;
  count: number;
}

export interface HexPointValue {
  lng: number;
  lat: number;
  value: number;
}

export type MapBounds = [[west: number, south: number], [east: number, north: number]];

export interface IndiaBoundary {
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][][] | number[][][];
  };
}

export interface IndiaGridCell {
  id: string;
  center: { lat: number; lng: number };
  rings: Ring[];
}

const INDIA_BOUNDS: MapBounds = [[68, 6], [98, 38]];
const TARGET_VISIBLE_HEXES = 900;
const MERCATOR_RADIUS_M = 6_378_137;
const MAX_MERCATOR_LAT = 85.051129;
const MIN_HEX_RADIUS_M = 300;

interface BoundaryPolygon {
  bounds: [west: number, south: number, east: number, north: number];
  outer: number[][];
  holes: number[][][];
}

const preparedBoundaries = new WeakMap<IndiaBoundary["geometry"], BoundaryPolygon[]>();

function countryRingContains(ring: number[][], lng: number, lat: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isInsideIndia(geometry: IndiaBoundary["geometry"], lng: number, lat: number) {
  let polygons = preparedBoundaries.get(geometry);
  if (!polygons) {
    const rawPolygons = geometry.type === "Polygon"
      ? [geometry.coordinates as number[][][]]
      : geometry.coordinates as number[][][][];
    polygons = rawPolygons.map(([outer, ...holes]) => {
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      for (const [longitude, latitude] of outer) {
        west = Math.min(west, longitude);
        south = Math.min(south, latitude);
        east = Math.max(east, longitude);
        north = Math.max(north, latitude);
      }
      return {
        bounds: [west, south, east, north],
        outer,
        holes,
      };
    });
    preparedBoundaries.set(geometry, polygons);
  }
  return polygons.some((polygon) => lng >= polygon.bounds[0] && lng <= polygon.bounds[2]
    && lat >= polygon.bounds[1] && lat <= polygon.bounds[3]
    && countryRingContains(polygon.outer, lng, lat)
    && !polygon.holes.some((hole) => countryRingContains(hole, lng, lat)));
}

function toMercator(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return [
    MERCATOR_RADIUS_M * lng * Math.PI / 180,
    MERCATOR_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + clampedLat * Math.PI / 360)),
  ];
}

function fromMercator(x: number, y: number): [number, number] {
  return [
    x / MERCATOR_RADIUS_M * 180 / Math.PI,
    (2 * Math.atan(Math.exp(y / MERCATOR_RADIUS_M)) - Math.PI / 2) * 180 / Math.PI,
  ];
}

/** Generate a bounded, country-clipped display grid; closer zooms use smaller cells. */
export function createIndiaHexGrid(bounds: MapBounds, zoom: number, boundary: IndiaBoundary): IndiaGridCell[] {
  const [[west, south], [east, north]] = bounds;
  const clippedWest = Math.max(west, INDIA_BOUNDS[0][0]);
  const clippedSouth = Math.max(south, INDIA_BOUNDS[0][1]);
  const clippedEast = Math.min(east, INDIA_BOUNDS[1][0]);
  const clippedNorth = Math.min(north, INDIA_BOUNDS[1][1]);
  if (clippedWest >= clippedEast || clippedSouth >= clippedNorth) return [];

  const [minX, maxY] = toMercator(clippedWest, clippedNorth);
  const [maxX, minY] = toMercator(clippedEast, clippedSouth);
  // Keep each integer zoom level on a globally aligned grid; cells keep
  // subdividing through the 300 m source-data scale instead of stopping at 8 km.
  const zoomLevel = Math.max(0, Math.floor(zoom));
  const baseRadius = Math.max(MIN_HEX_RADIUS_M, 1_500_000 / 2 ** zoomLevel);
  const estimatedCount = ((maxX - minX) / (Math.sqrt(3) * baseRadius) + 2)
    * ((maxY - minY) / (1.5 * baseRadius) + 2);
  // Coarsen the whole grid when a very wide view would exceed the render
  // budget. Never truncate by row: doing so left one side of India unfilled.
  const radius = estimatedCount > TARGET_VISIBLE_HEXES
    ? baseRadius * Math.sqrt(estimatedCount / TARGET_VISIBLE_HEXES) * 1.04
    : baseRadius;
  const stepX = Math.sqrt(3) * radius;
  const stepY = 1.5 * radius;
  const firstRow = Math.floor((minY - radius) / stepY);
  const lastRow = Math.ceil((maxY + radius) / stepY);
  const firstColumn = Math.floor(minX / stepX) - 2;
  const lastColumn = Math.ceil(maxX / stepX) + 2;
  const cells: IndiaGridCell[] = [];

  for (let row = firstRow; row <= lastRow; row++) {
    const centerY = row * stepY;
    for (let column = firstColumn; column <= lastColumn; column++) {
      const centerX = (column + (Math.abs(row % 2) ? 0.5 : 0)) * stepX;
      const [lng, lat] = fromMercator(centerX, centerY);
      if (lng < clippedWest - 0.3 || lng > clippedEast + 0.3
        || lat < clippedSouth - 0.3 || lat > clippedNorth + 0.3
        || !isInsideIndia(boundary.geometry, lng, lat)) continue;
      const ring: Ring = [];
      for (let vertex = 0; vertex < 6; vertex++) {
        const angle = (90 + vertex * 60) * Math.PI / 180;
        ring.push(fromMercator(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)));
      }
      ring.push(ring[0]);
      cells.push({ id: `${row}:${column}`, center: { lat, lng }, rings: [ring] });
    }
  }
  return cells;
}

function ringContainsPoint(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function shapeContainsPoint(rings: Ring[], lng: number, lat: number): boolean {
  return Boolean(rings.length && ringContainsPoint(rings[0], lng, lat)
    && !rings.slice(1).some((ring) => ringContainsPoint(ring, lng, lat)));
}

export function getMapDetail(zoom: number): MapDetail {
  if (zoom < 11.5) return "city";
  if (zoom < 13) return "district";
  return "cells";
}

/** Average available values by source-cell overlap. Null marks mapped water. */
export function summarizeHexes(mesh: HexCell[], values: ReadonlyMap<string, number | null>): HexSummary[] {
  const summaries: HexSummary[] = [];
  for (const hex of mesh) {
    let covered = false;
    let count = 0;
    let weightedSum = 0;
    let totalArea = 0;
    for (const [key, area] of hex.overlaps) {
      const value = values.get(key);
      if (value === undefined) continue;
      covered = true;
      if (value === null) continue;
      count++;
      weightedSum += value * area;
      totalArea += area;
    }
    if (!covered) continue;
    const value = totalArea > 0 ? weightedSum / totalArea : null;
    for (const rings of hex.shapes) summaries.push({ rings, value, count });
  }
  return summaries;
}

/** Average point-based model cells into the same display hex mesh. */
export function summarizeHexPoints(mesh: HexCell[], points: readonly HexPointValue[]): HexSummary[] {
  const summaries: HexSummary[] = [];
  for (const hex of mesh) {
    const values: number[] = [];
    for (const point of points) {
      if (hex.shapes.some((rings) => shapeContainsPoint(rings, point.lng, point.lat))) {
        values.push(point.value);
      }
    }
    if (!values.length) continue;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    for (const rings of hex.shapes) summaries.push({ rings, value: average, count: values.length });
  }
  return summaries;
}
