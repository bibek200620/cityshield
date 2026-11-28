import { create } from "zustand";
import {
  api,
  CriticalInfraItem,
  LatLng,
  RouteResponse,
  ScenarioSummary,
  SimulateResponse,
  HeatWorkflowResponse,
  ExposureResponse,
} from "../api/client";

export interface LayerVisibility {
  roads: boolean;
  floodDepth: boolean;
  cityRunoff: boolean;
  pilotFlood: boolean;
  cityRoads: boolean;
  drainage: boolean;
  infra: boolean;
  route: boolean;
  heat: boolean;
  surfaceTemperature: boolean;
  cityHeat: boolean;
  pilotExposure: boolean;
  combined: boolean;
}

export type VehicleType = "ambulance" | "fire" | "rescue" | "police";
export const floodDemoPreset = { id: "flood-demo", intensity: 100, duration: 120 } as const;
export const rainfallLimits = {
  intensity: { min: 5, max: 150 },
  duration: { min: 15, max: 180 },
} as const;

export interface AppliedRainfallScenario {
  revision: number;
  rainfallMm: number;
  durationMin: number;
  floodDemo: boolean;
}

interface TemperatureOffsets {
  air: number;
  surface: number;
}

interface FloodStore {
  scenarios: ScenarioSummary[];
  activeScenarioId: string | null;
  selectedPresetId: string | null;
  simulateResult: SimulateResponse | null;
  criticalInfra: CriticalInfraItem[];
  route: RouteResponse | null;
  selectedRouteId: string;
  vehicleType: VehicleType;
  selectedNodeId: string | null;
  simulationActive: boolean;
  appliedRainfall: AppliedRainfallScenario | null;
  heatOffsetC: number;
  surfaceOffsetC: number;
  currentRainfall: { intensity: number; duration: number };
  heatData: HeatWorkflowResponse | null;
  combinedExposure: ExposureResponse | null;
  combinedExposureError: string | null;
  heatLoading: boolean;
  heatError: string | null;
  layerVisibility: LayerVisibility;
  activeNav: string;
  searchQuery: string;
  loading: boolean;
  error: string | null;

  loadInitial: () => Promise<void>;
  loadHeat: () => Promise<void>;
  runScenario: (scenarioId: string, offsets: TemperatureOffsets) => Promise<void>;
  runCustomRainfall: (intensity: number, duration: number, offsets: TemperatureOffsets, floodDemo?: boolean) => Promise<void>;
  stopSimulation: () => void;
  hasPendingRainfall: () => boolean;
  computeRoute: (start: LatLng, end: LatLng, vehicle?: VehicleType) => Promise<void>;
  setVehicleType: (vt: VehicleType) => void;
  setSelectedRouteId: (id: string) => void;
  setActiveNav: (nav: string) => void;
  setSearchQuery: (query: string) => void;
  selectNode: (nodeId: string | null) => void;
  toggleLayer: (key: keyof LayerVisibility) => void;
}

export const useFloodStore = create<FloodStore>((set, get) => {
  let scenarioRequest: AbortController | null = null;
  let revision = 0;

  async function runRainfall(
    intensity: number, duration: number, presetId: string | null, offsets: TemperatureOffsets,
    load: (signal: AbortSignal) => Promise<SimulateResponse>,
  ) {
    scenarioRequest?.abort();
    const request = new AbortController();
    scenarioRequest = request;
    set({ loading: true, error: null });
    try {
      const result = await load(request.signal);
      if (request.signal.aborted) return;
      const floodDemo = presetId === floodDemoPreset.id;
      const appliedRainfall = {
        revision: ++revision, rainfallMm: intensity * duration / 60, durationMin: duration, floodDemo,
      };
      set((state) => ({
        simulationActive: true,
        appliedRainfall,
        simulateResult: result,
        activeScenarioId: result.scenario_id,
        route: null,
        selectedPresetId: presetId,
        currentRainfall: { intensity, duration },
        heatOffsetC: offsets.air,
        surfaceOffsetC: offsets.surface,
        combinedExposure: null,
        combinedExposureError: null,
        layerVisibility: {
          ...state.layerVisibility, cityRunoff: true, cityRoads: true,
          pilotFlood: floodDemo || state.layerVisibility.pilotFlood,
          heat: offsets.air !== 0 || state.layerVisibility.heat,
          cityHeat: offsets.surface !== 0 || state.layerVisibility.cityHeat,
        },
      }));
      try {
        const combinedExposure = await api.getCombinedExposure(result.scenario_id, request.signal);
        if (!request.signal.aborted) set({ combinedExposure });
      } catch (error) {
        if (!request.signal.aborted) set({ combinedExposureError: (error as Error).message });
      }
    } catch (error) {
      if (!request.signal.aborted) set({ error: (error as Error).message });
    } finally {
      if (scenarioRequest === request) {
        scenarioRequest = null;
        set({ loading: false });
      }
    }
  }

  return {
    scenarios: [],
    activeScenarioId: null,
    selectedPresetId: null,
    simulateResult: null,
    criticalInfra: [],
    route: null,
    selectedRouteId: "recommended",
    vehicleType: "ambulance",
    selectedNodeId: null,
    simulationActive: false,
    appliedRainfall: null,
    heatOffsetC: 0,
    surfaceOffsetC: 0,
    currentRainfall: { intensity: 60, duration: 90 },
    heatData: null,
    combinedExposure: null,
    combinedExposureError: null,
    heatLoading: false,
    heatError: null,
    layerVisibility: {
      roads: true,
      floodDepth: false,
      cityRunoff: false,
      pilotFlood: false,
      cityRoads: false,
      drainage: true,
      infra: true,
      route: true,
      heat: false,
      surfaceTemperature: false,
      cityHeat: false,
      pilotExposure: false,
      combined: false,
    },
    activeNav: "Dashboard",
    searchQuery: "",
    loading: false,
    error: null,

    loadHeat: async () => {
      set({ heatLoading: true, heatError: null });
      try {
        const heatData = await api.getHeatWorkflow();
        set({ heatData });
      } catch (e) {
        set({ heatData: null, heatError: (e as Error).message });
      } finally {
        set({ heatLoading: false });
      }
    },

    loadInitial: async () => {
      set({ loading: true, error: null });
      try {
        const [scenarios, infra] = await Promise.all([
          api.getScenarios(),
          api.getCriticalInfrastructure(),
        ]);
        set({ scenarios, criticalInfra: infra });
        void get().loadHeat();
      } catch (error) {
        set({ error: (error as Error).message });
      } finally {
        if (!scenarioRequest) set({ loading: false });
      }
    },

    runScenario: async (scenarioId, offsets) => {
      const scenario = get().scenarios.find((item) => item.scenario_id === scenarioId);
      if (!scenario) return;
      await runRainfall(scenario.rainfall_intensity_mm_hr, scenario.duration_min, scenarioId, offsets,
        (signal) => api.getScenarioDetail(scenarioId, signal));
    },

    runCustomRainfall: (intensity, duration, offsets, floodDemo = false) => runRainfall(
      intensity, duration, floodDemo ? floodDemoPreset.id : null, offsets,
      (signal) => api.simulate(intensity, duration, signal)),

    hasPendingRainfall: () => scenarioRequest !== null,

    stopSimulation: () => {
      scenarioRequest?.abort();
      scenarioRequest = null;
      set((state) => ({
        simulationActive: false,
        appliedRainfall: null,
        heatOffsetC: 0,
        surfaceOffsetC: 0,
        simulateResult: null,
        activeScenarioId: null,
        combinedExposure: null,
        combinedExposureError: null,
        route: null,
        loading: false,
        error: null,
        layerVisibility: { ...state.layerVisibility, cityRunoff: false, pilotFlood: false, pilotExposure: false },
      }));
    },

    computeRoute: async (start: LatLng, end: LatLng, vehicle?: VehicleType) => {
      const scenarioId = get().activeScenarioId;
      if (!scenarioId) return;
      const vt = vehicle ?? get().vehicleType;
      set({ loading: true, error: null });
      try {
        const route = await api.route(start, end, scenarioId, "astar", vt);
        if (get().activeScenarioId === scenarioId) set({ route, selectedRouteId: "recommended" });
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        set({ loading: false });
      }
    },

    setVehicleType: (vehicleType: VehicleType) => {
      set({ vehicleType });
      const currentRoute = get().route;
      if (currentRoute) {
        // Re-trigger with new vehicle type if locations known or adjust ETA locally
        set({
          route: {
            ...currentRoute,
            active_vehicle: vehicleType,
          },
        });
      }
    },

    setSelectedRouteId: (selectedRouteId: string) => set({ selectedRouteId }),
    setActiveNav: (activeNav: string) => set({ activeNav }),
    setSearchQuery: (searchQuery: string) => set({ searchQuery }),
    selectNode: (nodeId: string | null) => set({ selectedNodeId: nodeId }),
    toggleLayer: (key: keyof LayerVisibility) =>
      set((state) => ({ layerVisibility: { ...state.layerVisibility, [key]: !state.layerVisibility[key] } })),
  };
});
