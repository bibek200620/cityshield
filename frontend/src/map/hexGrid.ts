type Ring = [number, number][];

interface HexCell {
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
