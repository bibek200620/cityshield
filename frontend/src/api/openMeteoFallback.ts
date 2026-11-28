import type { LatLng, TwoDayWeatherReportResponse, WeatherAvailabilityResponse } from "./client";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const LOCATION = { latitude: 12.98, longitude: 77.59 };
const HOUR = 3600;
const HOURLY_UNITS = {
  temperature_2m: "°C",
  apparent_temperature: "°C",
  relative_humidity_2m: "%",
  precipitation: "mm",
};

type Nowcast = Extract<WeatherAvailabilityResponse, { status: "ready" }>;
type Report = Extract<TwoDayWeatherReportResponse, { status: "ready" }>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Missing Open-Meteo data");
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error("Invalid Open-Meteo value");
  }
  return value;
}

function optionalCode(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value : null;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function readForecast(value: unknown, now: number, location: LatLng): { nowcast: Nowcast; report: Report } {
  const payload = record(value);
  const current = record(payload.current);
  const hourly = record(payload.hourly);
  const currentUnits = record(payload.current_units);
  const hourlyUnits = record(payload.hourly_units);
  const timezone = payload.timezone;
  if (typeof timezone !== "string" || !timezone || payload.utc_offset_seconds !== 0 ||
    currentUnits.time !== "unixtime" || hourlyUnits.time !== "unixtime" ||
    currentUnits.temperature_2m !== "°C" || currentUnits.apparent_temperature !== "°C" ||
    Object.entries(HOURLY_UNITS).some(([key, unit]) => hourlyUnits[key] !== unit)) {
    throw new Error("Unexpected Open-Meteo units or time zone");
  }
  const validAt = number(current.time, now - HOUR, now + 900);
  const hour = Math.floor(now / HOUR) * HOUR;
  const times = hourly.time;
  if (!Array.isArray(times) || new Set(times).size !== times.length) {
    throw new Error("Invalid Open-Meteo hourly timestamps");
  }
  const indices = new Map(times.map((time, index) => [number(time), index]));
  const valueAt = (key: string, timestamp: number): unknown => {
    const series = hourly[key];
    const index = indices.get(timestamp);
    return Array.isArray(series) && series.length === times.length && index !== undefined
      ? series[index] : undefined;
  };
  const hours = Array.from({ length: 48 }, (_, index) => {
    const time = hour + (index + 1) * HOUR;
    return {
      valid_at: iso(time),
      air_temperature_c: number(valueAt("temperature_2m", time)),
      feels_like_c: number(valueAt("apparent_temperature", time)),
      relative_humidity_pct: number(valueAt("relative_humidity_2m", time), 0, 100),
      precipitation_mm: number(valueAt("precipitation", time), 0),
      weather_code: optionalCode(valueAt("weather_code", time), 99),
      is_day: optionalCode(valueAt("is_day", time), 1),
    };
  });
  const recentRain = number(valueAt("precipitation", hour - HOUR), 0) +
    number(valueAt("precipitation", hour), 0);
  const shared = {
    status: "ready" as const,
    provenance: {
      cell_selection: "land", model_identifier: null, model_version: null,
      model_note: "The response does not identify the exact model or model run.",
      requested_location: { latitude: location.lat, longitude: location.lng },
      grid_cell_center: {
        latitude: number(payload.latitude, -90, 90),
        longitude: number(payload.longitude, -180, 180),
        elevation_m: number(payload.elevation),
      },
      spatial_resolution_m: null,
      spatial_resolution_note: "The API response does not provide one resolution for its automatically combined models.",
      timezone, utc_offset_seconds: 0, timestamps_are_unix_utc: true,
      units: { air_temperature: "°C", apparent_temperature: "°C", relative_humidity: "%", precipitation: "mm" },
      retrieved_at: iso(now),
    },
  };
  const nextThreeHours = hours.slice(0, 3);
  return {
    nowcast: {
      ...shared, valid_at: iso(validAt),
      air_temperature_c: number(current.temperature_2m),
      feels_like_c: number(current.apparent_temperature),
      weather_code: optionalCode(current.weather_code, 99),
      is_day: optionalCode(current.is_day, 1),
      recent_rain_mm: recentRain,
      recent_through: iso(hour),
      upcoming_rain_mm: nextThreeHours.reduce((sum, slot) => sum + slot.precipitation_mm, 0),
      forecast_through: hours[2].valid_at,
      hourly_forecast: nextThreeHours,
    },
    report: {
      ...shared, forecast_hours: 48,
      forecast_from: hours[0].valid_at,
      forecast_through: hours[47].valid_at,
      hourly_forecast: hours,
    },
  };
}

const pending = new Map<string, ReturnType<typeof fetchForecast>>();
const cached = new Map<string, { intervals: ReturnType<typeof readForecast>; expiresAt: number }>();

async function fetchForecast(location: LatLng) {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    latitude: String(location.lat), longitude: String(location.lng),
    current: "temperature_2m,apparent_temperature,weather_code,is_day",
    hourly: [...Object.keys(HOURLY_UNITS), "weather_code", "is_day"].join(","),
    timezone: "UTC", timeformat: "unixtime", cell_selection: "land",
    past_hours: "2", forecast_hours: "49",
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(6500), referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("Open-Meteo request failed");
  const payload: unknown = await response.json();
  const now = Date.now() / 1000;
  const intervals = readForecast(payload, now, location);
  return intervals;
}

export async function withOpenMeteoFallback<K extends "nowcast" | "report">(
  backend: { nowcast: WeatherAvailabilityResponse; report: TwoDayWeatherReportResponse }[K],
  kind: K,
  signal?: AbortSignal,
  location: LatLng = { lat: LOCATION.latitude, lng: LOCATION.longitude },
) {
  signal?.throwIfAborted();
  if (backend.status !== "unavailable" || !["upstream_error", "timeout"].includes(backend.reason)) {
    return backend;
  }
  const key = `${location.lat},${location.lng}`;
  try {
    const existing = cached.get(key);
    if (existing && Date.now() / 1000 < existing.expiresAt) return existing.intervals[kind];
    let request = pending.get(key);
    if (!request) {
      request = fetchForecast(location).then((intervals) => {
        const now = Date.now() / 1000;
        cached.set(key, { intervals, expiresAt: Math.min(now + 300, (Math.floor(now / HOUR) + 1) * HOUR) });
        return intervals;
      }).finally(() => { pending.delete(key); });
      pending.set(key, request);
    }
    const intervals = await request;
    signal?.throwIfAborted();
    return intervals[kind];
  } catch {
    signal?.throwIfAborted();
    return { ...backend, message: "CityShield and the direct forecast source are temporarily unavailable." };
  }
}
