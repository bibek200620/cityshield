import { withOpenMeteoFallback } from "./openMeteoFallback";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface WeatherGridLocation extends LatLng {
  id: string;
}

export interface WeatherGridResponse {
  status: "ready" | "partial" | "unavailable";
  results: {
    id: string;
    air_temperature_2m_c: number;
    feels_like_2m_c: number | null;
    relative_humidity_pct: number | null;
    wind_speed_kmh: number | null;
    rainfall_24h_mm: number;
    model_grid_center: LatLng;
    model_run: string;
    valid_start: string;
    valid_end: string;
    retrieved_at: string;
    stale: boolean;
  }[];
  checked_locations: number;
  unavailable_locations: number;
  checked_at: string;
}

export interface PointForecastResponse {
  location: { latitude: number; longitude: number };
  model_run: string | null;
  model_updated_at: string | null;
  retrieved_at: string;
  current?: {
    valid_at: string | null;
    air_temperature_c: number | null;
    feels_like_c: number | null;
    heat_index_c: number | null;
    relative_humidity_pct: number | null;
    wind_speed_kmh: number | null;
    uv_index: number | null;
    precipitation_1h_mm: number | null;
    condition: string | null;
  };
  hours: {
    valid_at: string;
    air_temperature_c: number;
    feels_like_c: number;
    precipitation_mm: number;
    precipitation_probability_pct?: number | null;
    relative_humidity_pct: number | null;
    wind_speed_kmh?: number | null;
    uv_index?: number | null;
    wet_bulb_c?: number | null;
    condition?: string | null;
    pictocode?: number;
  }[];
  limitations?: string[];
}

export type PointAirQualityResponse = {
  status: "unavailable";
  message: string;
} | {
  status: "ready" | "empty";
  checked_at: string;
  valid_at: string | null;
  indexes: { name: string; value: number; category: string; dominant_pollutant: string | null }[];
  pollutants: { name: string; value: number | null; unit: string | null }[];
  limitations: string[];
};

export interface NearbyFacilitiesResponse {
  status: "ready" | "empty";
  checked_at: string;
  results: { id: string; name: string; category: string | null; latitude: number; longitude: number;
    map_url: string | null; status: "mapped_listing_unverified" }[];
  limitations: string[];
}

export interface FloodHistoryResponse {
  status: "ready" | "unavailable";
  location: string;
  location_precision: "district";
  events: {
    id: string;
    start_date: string;
    end_date: string;
    date_precision: string;
    reported_cause: string;
    source_event_source: string;
    districts_listed: string[];
    location_name: string;
    location_precision: "district";
    has_coordinates: false;
    multi_district_event: boolean;
    evaluation_eligible: false;
    quality_flags: string[];
  }[];
  limitations: string[];
  citation: { dataset: string; doi: string; license: string };
}

export interface PlaceSearchResult extends LatLng {
  id: string;
  name: string;
  category: string;
}

export interface PlaceSearchResponse {
  status: "ready";
  source: string;
  attribution: string;
  results: PlaceSearchResult[];
}

export interface DrivingOption {
  id: string;
  labels: string[];
  distance_km: number;
  eta_seconds: number;
  coordinates: [number, number][];
  guidance?: { point_index: number; instruction: string }[];
  traffic_time_delta_seconds?: number | null;
  traffic_segments?: { start_index: number; end_index: number; level: TrafficLevel }[] | null;
  nearby_flood_reports?: number;
  runoff?: { covered_km: number; current_km: number; forecast_km: number };
  forecast_runoff_spans?: { start: number; end: number }[];
}

export type TrafficLevel = "clear" | "slow" | "heavy" | "unknown";
export type TrafficFlowResponse = { status: "unavailable" } | {
  status: "ready"; checked_at: string; segments: NonNullable<DrivingOption["traffic_segments"]>;
};

export interface ScenarioRouteExposure {
  covered_km: number;
  route_km: number;
  exposed_km: number;
  high_km: number;
  spans: { start: number; end: number }[];
  high_spans: { start: number; end: number }[];
}

export type ScenarioRouteResponse = { status: "ready"; routes: ScenarioRouteExposure[] }
  | { status: "unavailable"; message: string };

export interface DrivingResponse {
  routes: DrivingOption[];
  shortest_available: boolean;
  source: string;
  weather: WeatherAvailabilityResponse;
  traffic: { status: "ready" | "unavailable"; message: string; checked_at?: string };
  runoff_available: boolean;
  flood_reports: { status: "ready" | "unavailable"; source: string; checked_at?: string };
}

export type AssistantAlertKind = "city_flood" | "route_rain" | "traffic";

export type AssistantOutlook = { status: "unavailable" } | {
  status: "ready";
  checked_at: string;
  forecast_through: string;
  alert: { valid_at: string; cells: number } | null;
  forecast_points?: number;
  heat?: { valid_at: string; feels_like_c: number } | null;
  flood_screen_available?: boolean;
};

export interface AssistantPhrasing {
  source: "preset" | "gemini";
  styles: Record<AssistantAlertKind, "direct" | "gentle">;
}

export interface CXConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export type CXConversationAction =
  | { kind: "route"; source?: string; destination?: string }
  | { kind: "weather"; hours?: number; day?: "today" | "tomorrow"; at_end?: boolean; focus?: "rain_probability" }
  | { kind: "eta" | "direction" };

type CXConversationResponse = { status: "ready"; reply: string; action?: CXConversationAction }
  | { status: "unavailable"; reason: "disabled" | "busy" | "upstream" };

export type AssistantRouteContext = { status: "unavailable" } | {
  status: "ready";
  weather: WeatherAvailabilityResponse;
  traffic: { checked_at: string; segments: NonNullable<DrivingOption["traffic_segments"]> } | null;
  forecast_runoff_spans: NonNullable<DrivingOption["forecast_runoff_spans"]>;
};

export interface CityFloodCell {
  id: string;
  rings: [number, number][][];
  screen_mm: number | null;
  depressed_land_percent: number | null;
}

export type CityFloodResponse =
  | { status: "unavailable"; message: string }
  | { status: "ready"; rainfall_mm: number; grid_m: number; source: string; model: string; cells: CityFloodCell[] };

export interface GeoLineString {
  type: "LineString";
  coordinates: [number, number][];
}

export interface ScenarioSummary {
  scenario_id: string;
  label: string;
  rainfall_intensity_mm_hr: number;
  duration_min: number;
}

export interface NodePrediction {
  node_id: string;
  lat: number;
  lng: number;
  depth_m_mean: number;
  depth_m_std: number;
}

export interface RoadSegment {
  edge_id: string;
  state: "clear" | "at_risk" | "flooded";
  geometry: GeoLineString;
}

export interface SimulateResponse {
  scenario_id: string;
  node_predictions: NodePrediction[];
  road_segments: RoadSegment[];
  model_caveat: string;
  is_synthetic_ward: boolean;
  model_mode: string;
  model_version: string;
  provenance_class: "simulated";
  rainfall_source: string;
  generated_at_utc: string;
  input_provenance: string[];
  limitations: string[];
  // infra_ids with zero access redundancy under this scenario -- lets the
  // map's demo-click affordance target a facility that's actually
  // vulnerable right now, not just whichever infra happens to be first.
  at_risk_infra_ids: string[];
}

export interface CriticalAccessRisk {
  infra_id: string;
  infra_type: string;
  infra_name: string;
  access_redundancy_score: number;
  message: string;
}

export interface RouteOption {
  id: string;
  name: string;
  tag: string;
  geometry: GeoLineString;
  eta_seconds: number;
  eta_minutes: number;
  distance_km: number;
  flooded_segments_count: number;
  avoided_flooded_segments: string[];
  is_safe: boolean;
  summary: string;
}

export interface RouteResponse {
  route_geometry: GeoLineString;
  eta_seconds: number;
  avoided_flooded_segments: string[];
  baseline_route_geometry: GeoLineString;
  baseline_eta_seconds: number;
  critical_access_risk: CriticalAccessRisk | null;
  routes?: RouteOption[];
  active_vehicle?: string;
}

export type WeatherAvailabilityResponse =
  | {
    status: "unavailable";
    message: string;
    reason: "timeout" | "upstream_error" | "stale_data" | "missing_data" | "invalid_data";
    checked_at: string;
  }
  | {
    status: "ready";
    is_stale?: boolean;
    stale_age_seconds?: number;
    provenance: {
      model_note: string;
      cell_selection: string;
      requested_location: { latitude: number; longitude: number };
      grid_cell_center: { latitude: number; longitude: number; elevation_m: number };
      spatial_resolution_m: number | null;
      spatial_resolution_note: string;
      timezone: string;
      utc_offset_seconds: number;
      timestamps_are_unix_utc: boolean;
      units: {
        air_temperature: string;
        apparent_temperature: string;
        relative_humidity: string;
        precipitation: string;
      };
      retrieved_at: string;
    };
    valid_at: string;
    air_temperature_c: number;
    feels_like_c: number;
    weather_code?: number | null;
    is_day?: number | null;
    recent_rain_mm: number;
    recent_through: string;
    upcoming_rain_mm: number;
    forecast_through: string;
    hourly_forecast: {
      valid_at: string;
      air_temperature_c: number;
      feels_like_c: number;
      relative_humidity_pct: number;
      precipitation_mm: number;
      weather_code?: number | null;
      is_day?: number | null;
    }[];
  };

export type TwoDayWeatherReportResponse =
  | Extract<WeatherAvailabilityResponse, { status: "unavailable" }>
  | {
    status: "ready";
    provenance: Extract<WeatherAvailabilityResponse, { status: "ready" }> ["provenance"];
    forecast_hours: 48;
    forecast_from: string;
    forecast_through: string;
    hourly_forecast: {
      valid_at: string;
      air_temperature_c: number;
      feels_like_c: number;
      relative_humidity_pct: number;
      precipitation_mm: number;
    }[];
  };

export interface HeatCell {
  grid_id: string;
  grid_row: number;
  grid_col: number;
  lng: number;
  lat: number;
  temperature_c: number;
  hotspot: boolean;
}

export interface HeatWorkflowResponse {
  status: "ready" | "unavailable";
  message: string;
  source: string;
  provenance_class: "remotely_sensed";
  output_kind: string;
  scene_id: string | null;
  acquisition_date: string | null;
  generated_at_utc: string | null;
  model_version: string | null;
  crs: string | null;
  pixel_resolution_m: number | null;
  hotspot_threshold_c: number | null;
  hotspot_definition: string;
  cells: HeatCell[];
  explanation_status: "available" | "unavailable";
  explanation_message: string;
  explanation_sample_pixels: number | null;
  feature_mean_abs_shap_c: Record<string, number>;
  limitations: string[];
}

export interface ExposureCell {
  grid_id: string;
  grid_i: number;
  grid_j: number;
  lng: number;
  lat: number;
  flood_depth_m: number | null;
  flood_elevated: boolean | null;
  lst_c: number | null;
  heat_elevated: boolean | null;
  both_elevated: boolean;
}

export interface ExposureResponse {
  status: "ready" | "unavailable";
  message: string;
  scenario_id: string;
  grid_crs: string;
  grid_resolution_m: number;
  flood_elevated_threshold_m: number;
  heat_elevated_definition: string;
  cells: ExposureCell[];
  limitations: string[];
}

export interface CriticalInfraItem {
  infra_id: string;
  infra_type: string;
  name: string;
  lat: number;
  lng: number;
}

type BacktestPartition = "development" | "holdout";

export interface StormBacktestEvent {
  event_id: string;
  catchment_id: string | null;
  partition: BacktestPartition | null;
  status: "ready" | "unavailable";
  message: string | null;
}

export interface StormBacktestSample {
  timestamp: string;
  rainfall_mm: number;
  observed_depth_m: number;
  modeled_depth_m: number;
}

export interface StormBacktestSensor {
  id: string;
  name: string | null;
  node_id: string;
  gauge_id: string;
  latitude: number;
  longitude: number;
  series: StormBacktestSample[];
  metrics: {
    sample_count: number;
    mae_m: number;
    observed_peak_m: number;
    modeled_peak_m: number;
    observed_peak_at: string | null;
    modeled_peak_at: string | null;
    peak_timing_error_minutes: number | null;
  };
}

export interface StormBacktest {
  status: "ready";
  event_id: string;
  storm_group_id: string;
  catchment_id: string;
  partition: BacktestPartition;
  network_id: string;
  network_version: string;
  interval_minutes: number;
  model: { name: string; version: string; source_url: string | null; run_reference: string };
  observation_source: { title: string; url: string };
  sensors: StormBacktestSensor[];
  limitations: string[];
}

export class ApiRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as any);
    throw new ApiRequestError(res.status, body.message || body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

function weatherApiUnavailable() {
  return {
    status: "unavailable" as const,
    message: "CityShield's weather service is unreachable; trying an alternate forecast source.",
    reason: "upstream_error" as const,
    checked_at: new Date().toISOString(),
  };
}

export const api = {
  driveRoutes: (source: LatLng, destination: LatLng, signal: AbortSignal) =>
    request<DrivingResponse>("/api/drive/routes", {
      method: "POST",
      body: JSON.stringify({ source, destination }),
      signal,
    }),
  screenDrivingScenario: (rainfallMm: number, routes: DrivingOption["coordinates"][], signal: AbortSignal) =>
    request<ScenarioRouteResponse>("/api/drive/scenario", {
      method: "POST", body: JSON.stringify({ rainfall_mm: rainfallMm, routes }), signal,
    }),
  sampleTraffic: (coordinates: DrivingOption["coordinates"], signal: AbortSignal) =>
    request<TrafficFlowResponse>("/api/drive/traffic-flow", {
      method: "POST", body: JSON.stringify({ coordinates }), signal,
    }),
  searchPlaces: (query: string, signal: AbortSignal) =>
    request<PlaceSearchResponse>(`/api/places/search?query=${encodeURIComponent(query)}`, { signal }),
  getCityFlood: (rainfallMm: number, signal: AbortSignal) =>
    request<CityFloodResponse>(`/api/flood/city?rainfall_mm=${rainfallMm}`, { signal }),
  listStormBacktests: (signal: AbortSignal) =>
    request<{ events: StormBacktestEvent[] }>("/api/backtest", { signal }),
  getStormBacktest: (eventId: string, signal: AbortSignal) =>
    request<StormBacktest>(`/api/backtest/${encodeURIComponent(eventId)}`, { signal }),
  getScenarios: () => request<ScenarioSummary[]>("/api/scenarios"),
  getScenarioDetail: (scenarioId: string, signal?: AbortSignal) => request<SimulateResponse>(`/api/scenarios/${scenarioId}`, { signal }),
  getCriticalInfrastructure: () => request<CriticalInfraItem[]>("/api/critical-infrastructure"),
  getWeatherNowcast: async (signal?: AbortSignal, location?: LatLng): Promise<WeatherAvailabilityResponse> => {
    const query = location ? `?latitude=${location.lat}&longitude=${location.lng}` : "";
    let response: WeatherAvailabilityResponse;
    try {
      response = await request<WeatherAvailabilityResponse>(`/api/weather/nowcast${query}`, { signal });
    } catch (reason) {
      if (signal?.aborted) throw reason;
      response = weatherApiUnavailable();
    }
    return withOpenMeteoFallback(response, "nowcast", signal, location);
  },
  getWeatherReport: async (signal?: AbortSignal, location?: LatLng): Promise<TwoDayWeatherReportResponse> => {
    const query = location ? `?latitude=${location.lat}&longitude=${location.lng}` : "";
    let response: TwoDayWeatherReportResponse;
    try {
      response = await request<TwoDayWeatherReportResponse>(`/api/weather/report${query}`, { signal });
    } catch (reason) {
      if (signal?.aborted) throw reason;
      response = weatherApiUnavailable();
    }
    return withOpenMeteoFallback(response, "report", signal, location);
  },
  getWeatherGrid: (locations: WeatherGridLocation[], signal?: AbortSignal) =>
    request<WeatherGridResponse>("/api/weather/grid", {
      method: "POST", body: JSON.stringify({ locations }), signal,
    }),
  getPointForecast: (location: LatLng, signal?: AbortSignal) =>
    request<PointForecastResponse>(`/api/weather/point-forecast?latitude=${location.lat}&longitude=${location.lng}`, { signal }),
  getPointAirQuality: (location: LatLng, signal?: AbortSignal) =>
    request<PointAirQualityResponse>(`/api/weather/air-quality?latitude=${location.lat}&longitude=${location.lng}`, { signal }),
  getNearbyFacilities: (location: LatLng, signal?: AbortSignal) =>
    request<NearbyFacilitiesResponse>(`/api/places/nearby?latitude=${location.lat}&longitude=${location.lng}`, { signal }),
  getFloodHistory: (signal?: AbortSignal) => request<FloodHistoryResponse>("/api/flood/events", { signal }),
  getAssistantOutlook: (signal: AbortSignal) => request<AssistantOutlook>("/api/assistant/outlook", { signal }),
  getAssistantPhrasing: (signal: AbortSignal) => request<AssistantPhrasing>("/api/assistant/phrasing", { signal }),
  askCX: (message: string, history: CXConversationTurn[], signal: AbortSignal) =>
    request<CXConversationResponse>("/api/assistant/conversation", {
      method: "POST", body: JSON.stringify({ message, history }), signal,
    }),
  refreshAssistantRoute: (coordinates: DrivingOption["coordinates"], tomtom: boolean, signal: AbortSignal) =>
    request<AssistantRouteContext>("/api/assistant/route-context", {
      method: "POST", body: JSON.stringify({ coordinates, tomtom }), signal,
    }),
  getHeatWorkflow: () => request<HeatWorkflowResponse>("/api/heat"),
  getCombinedExposure: (scenarioId: string, signal?: AbortSignal) => request<ExposureResponse>(`/api/exposure/${scenarioId}`, { signal }),
  simulate: (rainfall_intensity_mm_hr: number, duration_min: number, signal?: AbortSignal) =>
    request<SimulateResponse>("/api/simulate", {
      method: "POST",
      body: JSON.stringify({ rainfall_intensity_mm_hr, duration_min }),
      signal,
    }),
  route: (
    start: LatLng,
    end: LatLng,
    scenario_id: string,
    algorithm: "astar" | "dijkstra" = "astar",
    vehicle_type: "ambulance" | "fire" | "rescue" | "police" = "ambulance"
  ) =>
    request<RouteResponse>("/api/route", {
      method: "POST",
      body: JSON.stringify({ start, end, scenario_id, algorithm, vehicle_type }),
    }),
  liveSocketUrl: (scenario_id: string) =>
    `${BASE_URL.replace(/^http/, "ws")}/ws/live?scenario_id=${scenario_id}`,
  explain: (nodeId: string, rainfallIntensityMmHr: number, durationMin: number) =>
    request<{ node_id: string; factors: { factor: string; depth_delta_m: number }[] }>(
      `/api/explain/${nodeId}?rainfall_intensity_mm_hr=${rainfallIntensityMmHr}&duration_min=${durationMin}`,
    ),
};
