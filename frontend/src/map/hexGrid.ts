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
