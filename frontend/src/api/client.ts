const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

export interface LatLng {
  lat: number;
  lng: number;
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
  traffic_time_delta_seconds?: number | null;
  nearby_flood_reports?: number;
  runoff?: { covered_km: number; current_km: number; forecast_km: number };
}

export interface DrivingResponse {
  routes: DrivingOption[];
  shortest_available: boolean;
  source: string;
  weather: WeatherAvailabilityResponse;
  traffic: { status: "ready" | "unavailable"; message: string };
  runoff_available: boolean;
  flood_reports: { status: "ready" | "unavailable"; source: string; checked_at?: string };
}

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
    reason: "timeout" | "provider_error" | "stale_data" | "missing_data" | "invalid_data";
    source: string;
    checked_at: string;
  }
  | {
    status: "ready";
    source: string;
    provenance: {
      provider: string;
      api_version: string;
      endpoint: string;
      model_selection: string;
      model_identifier: string | null;
      model_version: string | null;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as any);
    throw new Error(body.message || body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  driveRoutes: (source: LatLng, destination: LatLng, signal: AbortSignal) =>
    request<DrivingResponse>("/api/drive/routes", {
      method: "POST",
      body: JSON.stringify({ source, destination }),
      signal,
    }),
  searchPlaces: (query: string, signal: AbortSignal) =>
    request<PlaceSearchResponse>(`/api/places/search?query=${encodeURIComponent(query)}`, { signal }),
  getCityFlood: (rainfallMm: number, signal: AbortSignal) =>
    request<CityFloodResponse>(`/api/flood/city?rainfall_mm=${rainfallMm}`, { signal }),
  getScenarios: () => request<ScenarioSummary[]>("/api/scenarios"),
  getScenarioDetail: (scenarioId: string) => request<SimulateResponse>(`/api/scenarios/${scenarioId}`),
  getCriticalInfrastructure: () => request<CriticalInfraItem[]>("/api/critical-infrastructure"),
  getWeatherNowcast: (signal?: AbortSignal) => request<WeatherAvailabilityResponse>("/api/weather/nowcast", { signal }),
  getHeatWorkflow: () => request<HeatWorkflowResponse>("/api/heat"),
  getCombinedExposure: (scenarioId: string) => request<ExposureResponse>(`/api/exposure/${scenarioId}`),
  simulate: (rainfall_intensity_mm_hr: number, duration_min: number) =>
    request<SimulateResponse>("/api/simulate", {
      method: "POST",
      body: JSON.stringify({ rainfall_intensity_mm_hr, duration_min }),
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
