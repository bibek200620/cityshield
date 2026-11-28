import type { IndiaGridCell } from "./hexGrid";
import { api } from "../api/client";

export interface IndiaHexWeather {
  id: string;
  airTemperatureC: number | null;
  feelsLikeC: number | null;
  relativeHumidityPct: number | null;
  windSpeedKmh: number | null;
  rainfall24hMm: number | null;
  modelGridCenter: { lat: number; lng: number };
  modelRun: string;
  validStart: string;
  validEnd: string;
  stale?: boolean;
}

interface CachedWeather {
  value: Omit<IndiaHexWeather, "id">;
  expiresAt: number;
}

const CACHE_TTL_MS = 15 * 60_000;
const cache = new Map<string, CachedWeather>();

function locationKey(lat: number, lng: number) {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function fetchBatch(cells: IndiaGridCell[], signal: AbortSignal) {
  const result = await api.getWeatherGrid(cells.map((cell) => ({
    id: cell.id, lat: cell.center.lat, lng: cell.center.lng,
  })), signal);
  const expiresAt = Date.now() + CACHE_TTL_MS;
  const returned = new Map(result.results.map((item) => [item.id, item]));
  for (const cell of cells) {
    const value = returned.get(cell.id);
    if (!value) continue;
    cache.set(locationKey(cell.center.lat, cell.center.lng), {
      value: {
        airTemperatureC: numberOrNull(value.air_temperature_2m_c),
        feelsLikeC: numberOrNull(value.feels_like_2m_c),
        relativeHumidityPct: numberOrNull(value.relative_humidity_pct),
        windSpeedKmh: numberOrNull(value.wind_speed_kmh),
        rainfall24hMm: numberOrNull(value.rainfall_24h_mm),
        modelGridCenter: { lat: value.model_grid_center.lat, lng: value.model_grid_center.lng },
        modelRun: value.model_run,
        validStart: value.valid_start,
        validEnd: value.valid_end,
        stale: value.stale,
      },
      expiresAt: value.stale ? Date.now() + 60_000 : expiresAt,
    });
  }
  return { checked: result.checked_locations, unavailable: result.unavailable_locations };
}

/** Sample the visible India cells from the cached national grid forecast. */
export async function loadIndiaHexWeather(
  cells: IndiaGridCell[], signal: AbortSignal,
  onUpdate?: (weather: IndiaHexWeather[], unavailableLocations: number) => void,
): Promise<IndiaHexWeather[]> {
  const missing = new Map<string, IndiaGridCell>();
  for (const cell of cells) {
    const key = locationKey(cell.center.lat, cell.center.lng);
    const cached = cache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) missing.set(key, cell);
  }
  const missingCells = [...missing.values()];
  const collectVisible = () => cells.flatMap((cell) => {
    const cachedWeather = cache.get(locationKey(cell.center.lat, cell.center.lng));
    const value = cachedWeather && cachedWeather.expiresAt > Date.now() ? cachedWeather.value : null;
    return value ? [{ id: cell.id, ...value }] : [];
  });
  let unavailableLocations = 0;
  onUpdate?.(collectVisible(), unavailableLocations);
  if (missingCells.length && !signal.aborted) {
    try {
      const result = await fetchBatch(missingCells, signal);
      unavailableLocations += result.unavailable;
    } catch {
      if (signal.aborted) return [];
      unavailableLocations += missingCells.length;
    }
    if (!signal.aborted) onUpdate?.(collectVisible(), unavailableLocations);
  }
  if (signal.aborted) return [];
  const result = collectVisible();
  onUpdate?.(result, unavailableLocations);
  if (!result.length && unavailableLocations) throw new Error("No India grid forecasts could be loaded. Try again shortly.");
  return result;
}
