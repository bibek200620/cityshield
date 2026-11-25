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
  pilotFlood: boolean;
  drainage: boolean;
  infra: boolean;
  route: boolean;
  heat: boolean;
  combined: boolean;
}

export type VehicleType = "ambulance" | "fire" | "rescue" | "police";

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
  loadCombinedExposure: (scenarioId: string) => Promise<void>;
  runScenario: (scenarioId: string) => Promise<void>;
  runCustomRainfall: (intensity: number, duration: number, presetId?: string | null) => Promise<void>;
  computeRoute: (start: LatLng, end: LatLng, vehicle?: VehicleType) => Promise<void>;
  setVehicleType: (vt: VehicleType) => void;
  setSelectedRouteId: (id: string) => void;
  setActiveNav: (nav: string) => void;
  setSearchQuery: (query: string) => void;
  selectNode: (nodeId: string | null) => void;
  toggleLayer: (key: keyof LayerVisibility) => void;
}

export const useFloodStore = create<FloodStore>((set, get) => ({
  scenarios: [],
  activeScenarioId: null,
  selectedPresetId: null,
  simulateResult: null,
  criticalInfra: [],
  route: null,
  selectedRouteId: "recommended",
  vehicleType: "ambulance",
  selectedNodeId: null,
  currentRainfall: { intensity: 60, duration: 90 },
  heatData: null,
  combinedExposure: null,
  combinedExposureError: null,
  heatLoading: false,
  heatError: null,
  layerVisibility: {
    roads: true,
    floodDepth: true,
    pilotFlood: false,
    drainage: true,
    infra: true,
    route: true,
    heat: false,
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

  loadCombinedExposure: async (scenarioId: string) => {
    set({ combinedExposure: null, combinedExposureError: null });
    try {
      const exposure = await api.getCombinedExposure(scenarioId);
      set({ combinedExposure: exposure });
    } catch (e) {
      set({ combinedExposure: null, combinedExposureError: (e as Error).message });
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
      get().loadHeat();
      if (scenarios.length > 0) {
        await get().runScenario(scenarios[1]?.scenario_id ?? scenarios[0].scenario_id);
      }
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  runScenario: async (scenarioId: string) => {
    const scenario = get().scenarios.find((s) => s.scenario_id === scenarioId);
    if (!scenario) return;
    set({
      loading: true,
      error: null,
    });
    try {
      const result = await api.getScenarioDetail(scenarioId);
      set({
        simulateResult: result,
        activeScenarioId: result.scenario_id,
        route: null,
        selectedPresetId: scenarioId,
        currentRainfall: { intensity: scenario.rainfall_intensity_mm_hr, duration: scenario.duration_min },
      });
      await get().loadCombinedExposure(result.scenario_id);
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  runCustomRainfall: async (intensity: number, duration: number, presetId: string | null = null) => {
    set({
      loading: true,
      error: null,
    });
    try {
      const result = await api.simulate(intensity, duration);
      set({
        simulateResult: result,
        activeScenarioId: result.scenario_id,
        route: null,
        selectedPresetId: presetId,
        currentRainfall: { intensity, duration },
      });
      await get().loadCombinedExposure(result.scenario_id);
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  computeRoute: async (start: LatLng, end: LatLng, vehicle?: VehicleType) => {
    const scenarioId = get().activeScenarioId;
    if (!scenarioId) return;
    const vt = vehicle ?? get().vehicleType;
    set({ loading: true, error: null });
    try {
      const route = await api.route(start, end, scenarioId, "astar", vt);
      set({ route, selectedRouteId: "recommended" });
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
}));
