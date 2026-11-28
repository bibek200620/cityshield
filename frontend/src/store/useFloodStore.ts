import { create } from "zustand";
import {
  api,
  CriticalInfraItem,
  LatLng,
  RouteResponse,
  ScenarioSummary,
  SimulateResponse,
} from "../api/client";

export interface LayerVisibility {
  roads: boolean;
  floodDepth: boolean;
  pilotFlood: boolean;
  cityRoads: boolean;
  drainage: boolean;
  infra: boolean;
  route: boolean;
  heat: boolean;
  surfaceTemperature: boolean;
  combined: boolean;
}

export type VehicleType = "ambulance" | "fire" | "rescue" | "police";
export const floodDemoPreset = { id: "flood-demo", intensity: 100, duration: 120 } as const;

export interface AppliedRainfallScenario {
  revision: number;
  rainfallMm: number;
  durationMin: number;
  floodDemo: boolean;
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
  currentRainfall: { intensity: number; duration: number };
  layerVisibility: LayerVisibility;
  activeNav: string;
  searchQuery: string;
  loading: boolean;
  error: string | null;

  loadInitial: () => Promise<void>;
  runScenario: (scenarioId: string, heatOffsetC?: number) => Promise<void>;
  runCustomRainfall: (intensity: number, duration: number, heatOffsetC: number, floodDemo?: boolean) => Promise<void>;
  stopSimulation: () => void;
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
    intensity: number, duration: number, presetId: string | null, heatOffsetC: number | undefined,
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
      const appliedRainfall = heatOffsetC === undefined ? null : {
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
        heatOffsetC: heatOffsetC ?? 0,
        layerVisibility: heatOffsetC === undefined ? state.layerVisibility : {
          ...state.layerVisibility,
          pilotFlood: floodDemo || state.layerVisibility.pilotFlood,
        },
      }));
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
    currentRainfall: { intensity: 60, duration: 90 },
    layerVisibility: {
      roads: true,
      floodDepth: false,
      pilotFlood: false,
      cityRoads: false,
      drainage: true,
      infra: true,
      route: true,
      heat: false,
      surfaceTemperature: false,
      combined: false,
    },
    activeNav: "Dashboard",
    searchQuery: "",
    loading: false,
    error: null,

    loadInitial: async () => {
      set({ loading: true, error: null });
      try {
        const [scenarios, infra] = await Promise.all([
          api.getScenarios(),
          api.getCriticalInfrastructure(),
        ]);
        set({ scenarios, criticalInfra: infra });
      } catch (error) {
        set({ error: (error as Error).message });
      } finally {
        if (!scenarioRequest) set({ loading: false });
      }
    },

    runScenario: async (scenarioId, heatOffsetC) => {
      const scenario = get().scenarios.find((item) => item.scenario_id === scenarioId);
      if (!scenario) return;
      await runRainfall(scenario.rainfall_intensity_mm_hr, scenario.duration_min, scenarioId, heatOffsetC,
        (signal) => api.getScenarioDetail(scenarioId, signal));
    },

    runCustomRainfall: (intensity, duration, heatOffsetC, floodDemo = false) => runRainfall(
      intensity, duration, floodDemo ? floodDemoPreset.id : null, heatOffsetC,
      (signal) => api.simulate(intensity, duration, signal)),

    stopSimulation: () => {
      scenarioRequest?.abort();
      scenarioRequest = null;
      set((state) => ({
        simulationActive: false,
        appliedRainfall: null,
        heatOffsetC: 0,
        simulateResult: null,
        activeScenarioId: null,
        route: null,
        loading: false,
        error: null,
        layerVisibility: { ...state.layerVisibility, pilotFlood: false, cityRoads: false },
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
