import type { MultiPolygon, Polygon } from "geojson";
import type { CityFloodResponse } from "../api/client";
import type { CityHeat } from "../components/MapView";

type CellOverlap = [id: string, squareMeters: number];

export interface WardEvidence {
  geometry: Polygon | MultiPolygon;
  area_m2: number;
  flood: CellOverlap[];
  heat: CellOverlap[];
}

export type WardEvidenceIndex = Record<string, WardEvidence>;

export type ReadyCityFlood = Extract<CityFloodResponse, { status: "ready" }>;
export const highRunoffThresholdMm = 20;

export function countHighRunoffCells(flood: ReadyCityFlood): number {
  return new Set(flood.cells
    .filter((cell) => cell.screen_mm !== null && cell.screen_mm > highRunoffThresholdMm)
    .map((cell) => cell.id.split(":").slice(0, 2).join(":"))).size;
}

function summarizeOverlaps(overlaps: CellOverlap[], values: ReadonlyMap<string, number | null>) {
  let area = 0;
  let weightedSum = 0;
  let highArea = 0;
  for (const [id, overlap] of overlaps) {
    const value = values.get(id);
    if (value == null) continue;
    area += overlap;
    weightedSum += value * overlap;
    if (value > highRunoffThresholdMm) highArea += overlap;
  }
  return {
    areaKm2: area / 1_000_000,
    mean: area > 0 ? weightedSum / area : null,
    highAreaPercent: area > 0 ? 100 * highArea / area : null,
  };
}

export function summarizeWardRunoff(ward: WardEvidence, flood: ReadyCityFlood) {
  const values = new Map(flood.cells.map((cell) => [cell.id, cell.screen_mm]));
  return summarizeOverlaps(ward.flood, values);
}

export function summarizeWardHeat(ward: WardEvidence, heat: CityHeat) {
  const values = new Map<string, number>();
  for (const [, , temperature, key] of heat.cells) {
    if (key) values.set(key, temperature);
  }
  return summarizeOverlaps(ward.heat, values);
}
