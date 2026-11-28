import type { IndiaCity } from "./indiaCities";

export interface IndiaCityWeatherAlert {
  city: IndiaCity;
  rainfall24hMm: number;
  maximumTemperature24hC: number;
  heavyRain: boolean;
  highTemperature: boolean;
}

export interface IndiaCityScanResult {
  checked: number;
  unavailable: number;
  places: number;
  alerts: IndiaCityWeatherAlert[];
}

export const HEAVY_RAIN_SCREEN_MM = 64.5;
export const HIGH_TEMPERATURE_SCREEN_C = 40;

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const LOCATIONS_PER_REQUEST = 100;
const MAX_CONCURRENT_REQUESTS = 4;
const CACHE_TTL_MS = 15 * 60_000;
const cached = new Map<string, { value: Omit<IndiaCityWeatherAlert, "city">; expiresAt: number }>();

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function readForecast(payload: unknown, batch: IndiaCity[]) {
  const rows = Array.isArray(payload) ? payload : [payload];
  if (rows.length !== batch.length) throw new Error("Forecast service returned a mismatched city batch.");
  return rows.map((row) => {
    const hourly = record(record(row)?.hourly);
    const units = record(record(row)?.hourly_units);
    const rain = hourly?.precipitation;
    const temperatures = hourly?.temperature_2m;
    if (units?.precipitation !== "mm" || units?.temperature_2m !== "°C"
      || !Array.isArray(rain) || !Array.isArray(temperatures) || rain.length !== 24 || temperatures.length !== 24) {
      throw new Error("Forecast service returned incomplete city forecasts.");
    }
    const rainfall24hMm = rain.reduce<number>((sum, value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid rainfall forecast.");
      return sum + value;
    }, 0);
    const maximumTemperature24hC = Math.max(...temperatures.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid temperature forecast.");
      return value;
    }));
    return {
      rainfall24hMm,
      maximumTemperature24hC,
      heavyRain: rainfall24hMm >= HEAVY_RAIN_SCREEN_MM,
      highTemperature: maximumTemperature24hC >= HIGH_TEMPERATURE_SCREEN_C,
    };
  });
}

function availableAlerts(cities: IndiaCity[]) {
  const values = new Map<string, Omit<IndiaCityWeatherAlert, "city">>();
  for (const city of cities) {
    const item = cached.get(city.id);
    if (item && item.expiresAt > Date.now()) values.set(city.id, item.value);
  }
  return values;
}

async function fetchBatch(batch: IndiaCity[], signal: AbortSignal) {
  const url = new URL(FORECAST_URL);
  url.search = new URLSearchParams({
    latitude: batch.map((city) => city.lat.toFixed(4)).join(","),
    longitude: batch.map((city) => city.lng.toFixed(4)).join(","),
    hourly: "precipitation,temperature_2m",
    forecast_hours: "24",
    timezone: "auto",
  }).toString();
  const response = await fetch(url, { signal, headers: { Accept: "application/json" }, referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error(`Forecast service returned HTTP ${response.status}.`);
  const values = readForecast(await response.json() as unknown, batch);
  const expiresAt = Date.now() + CACHE_TTL_MS;
  batch.forEach((city, index) => cached.set(city.id, { value: values[index], expiresAt }));
}

/** Checks every place in the supplied catalog in bounded, independent coordinate batches. */
export async function scanIndiaCityForecasts(
  cities: IndiaCity[], signal: AbortSignal, onProgress?: (checked: number, total: number) => void,
): Promise<IndiaCityScanResult> {
  const values = availableAlerts(cities);
  const missing = cities.filter((city) => !values.has(city.id));
  const batches = missing.reduce<IndiaCity[][]>((result, city, index) => {
    const batchIndex = Math.floor(index / LOCATIONS_PER_REQUEST);
    (result[batchIndex] ??= []).push(city);
    return result;
  }, []);
  let nextBatch = 0;
  let unavailable = 0;
  let checked = values.size;
  onProgress?.(checked, cities.length);
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, batches.length) }, async () => {
    while (nextBatch < batches.length && !signal.aborted) {
      const batch = batches[nextBatch++];
      try {
        await fetchBatch(batch, signal);
        checked += batch.length;
      } catch {
        if (signal.aborted) return;
        unavailable += batch.length;
      }
      onProgress?.(checked + unavailable, cities.length);
    }
  }));
  signal.throwIfAborted();
  const completed = availableAlerts(cities);
  const alerts = cities.flatMap((city) => {
    const value = completed.get(city.id);
    return value && (value.heavyRain || value.highTemperature) ? [{ city, ...value }] : [];
  });
  return { checked: completed.size, unavailable: Math.max(unavailable, cities.length - completed.size), places: cities.length, alerts };
}
