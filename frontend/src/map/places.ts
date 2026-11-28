export interface MapPlace {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  center: [number, number];
  kannada?: string;
  corporation?: string;
}

export type BengaluruPlace = MapPlace & { corporation: string };

export function isBengaluruWard(place: MapPlace | null): place is BengaluruPlace {
  return Boolean(place?.corporation);
}

export function supportsBengaluruSimulation(place: MapPlace | null) {
  return isBengaluruWard(place) || Boolean(place && place.center[0] >= 77.39 && place.center[0] <= 77.85
    && place.center[1] >= 12.57 && place.center[1] <= 13.21);
}
