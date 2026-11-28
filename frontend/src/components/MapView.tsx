import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Layer } from "@deck.gl/core";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import type { FillExtrusionLayerSpecification } from "maplibre-gl";
import type { CityFloodCell, CityFloodResponse, DrivingOption, LatLng, NodePrediction, RoadSegment, ScenarioRouteExposure, TrafficLevel } from "../api/client";
import { createIndiaHexGrid, getMapDetail, summarizeHexes, type HexCell, type HexGrids, type HexSummary, type IndiaBoundary, type IndiaGridCell, type MapBounds, type MapDetail } from "../map/hexGrid";
import { loadIndiaHexWeather, type IndiaHexWeather } from "../map/nationalHexWeather";
import { createRoadRunoffScreen, ROAD_SCREEN_MIN_ZOOM, type RoadRunoff } from "../map/roadRunoff";
import { useFloodStore } from "../store/useFloodStore";
import type { MapPlace } from "./PlaceSearch";
import { pathForFraction, routeVertexDistances, type LiveLocation, type NavigationMode, type RouteMatch, type Waypoints } from "../map/drivingPlanner";
import Icon from "./Icon";

export interface CityHeat {
  scene_id: string;
  date: string;
  resolution_m: number;
  valid_pixel_fraction: number;
  rmse_c: number;
  cells: [lng: number, lat: number, temperature: number, gridKey?: string][];
}

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const AREA_VIEW = { padding: 48, maxZoom: 14.2 };
const INDIA_BOUNDS: maplibregl.LngLatBoundsLike = [[68, 6], [98, 38]];
const INDIA_VIEW = { padding: 30, duration: 0 };
const SURFACE_TEMPERATURE_TILES = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_Land_Surface_Temp_Daily_Day/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png";
const ROAD_COLORS = {
  clear: [80, 124, 179],
  at_risk: [177, 103, 32],
  flooded: [175, 45, 48],
} satisfies Record<RoadSegment["state"], [number, number, number]>;
const RUNOFF_COLORS: [number, number, number][] = [[119, 66, 179], [145, 28, 145], [97, 18, 85]];
const RAINFALL_PROXY_COLORS: [number, number, number][] = [
  [29, 119, 143], [52, 146, 139], [109, 174, 151], [165, 194, 151],
  [214, 217, 153], [218, 180, 107], [193, 128, 75], [143, 88, 61],
];
const TRAFFIC_COLORS = {
  clear: [34, 106, 217],
  slow: [239, 178, 20],
  heavy: [208, 42, 42],
  unknown: [97, 111, 135],
} satisfies Record<TrafficLevel, [number, number, number]>;
const TRAFFIC_LABELS: Record<TrafficLevel, string> = {
  clear: "No delay reported", slow: "Slow traffic", heavy: "Heavy delay or closure", unknown: "No segment detail",
};
const TEMPERATURE_PALETTE = [
  [234, 244, 255], [193, 218, 243], [147, 177, 215], [99, 127, 170],
  [55, 78, 122], [32, 91, 119], [28, 119, 130], [70, 144, 136],
  [141, 166, 137], [193, 180, 139], [204, 158, 112], [196, 124, 77],
  [183, 83, 74], [163, 46, 68], [119, 19, 50], [83, 7, 31],
] as const;

const FLOOD_LEGEND = [
  { label: "0 mm", color: RAINFALL_PROXY_COLORS[0] },
  { label: ">0–5 mm", color: RAINFALL_PROXY_COLORS[2] },
  { label: ">5–20 mm", color: RAINFALL_PROXY_COLORS[5] },
  { label: ">20 mm", color: RAINFALL_PROXY_COLORS[7] },
  { label: "Permanent water", color: [129, 141, 148] },
] as const;

function floodScreenColor(score: number | null): [number, number, number, number] {
  const index = score === null ? 4 : score === 0 ? 0 : score <= 5 ? 1 : score <= 20 ? 2 : 3;
  return [...FLOOD_LEGEND[index].color, index === 0 ? 110 : 175];
}

function depthColor(depth: number): [number, number, number, number] {
  const color = depth > 0.30 ? ROAD_COLORS.flooded : depth >= 0.15 ? ROAD_COLORS.at_risk : ROAD_COLORS.clear;
  return [...color, 235];
}

function temperatureColor(temperature: number): [number, number, number, number] {
  const position = Math.max(0, Math.min(1, (temperature - 15) / 30)) * (TEMPERATURE_PALETTE.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(TEMPERATURE_PALETTE.length - 1, lower + 1);
  const fraction = position - lower;
  return [0, 1, 2].map((channel) => Math.round(
    TEMPERATURE_PALETTE[lower][channel] + (TEMPERATURE_PALETTE[upper][channel] - TEMPERATURE_PALETTE[lower][channel]) * fraction,
  )).concat(178) as [number, number, number, number];
}

function temperatureLegendStyle() {
  const stops = TEMPERATURE_PALETTE.map((color, index) => {
    const percent = (index / (TEMPERATURE_PALETTE.length - 1) * 100).toFixed(2);
    return `rgba(${color.join(",")},0.698) ${percent}%`;
  });
  return { backgroundImage: `linear-gradient(90deg, ${stops.join(",")})` };
}

function rainfallProxyColor(rainfallMm: number): [number, number, number, number] {
  const index = rainfallMm < 1 ? 0 : rainfallMm <= 5 ? 2 : rainfallMm <= 20 ? 5 : 7;
  return [...RAINFALL_PROXY_COLORS[index], rainfallMm < 1 ? 100 : 185];
}

function rainfallSwatchStyle(color: [number, number, number], opacity: number) {
  return { backgroundColor: `rgba(${color.join(",")},${opacity / 255})` };
}

function valueOrUnavailable(value: number | null | undefined, suffix = "") {
  return value === null || value === undefined ? "Unavailable" : `${value.toFixed(1)}${suffix}`;
}

function floodRainStatus(rainfallMm: number | null | undefined) {
  if (rainfallMm === null || rainfallMm === undefined) return "Unavailable";
  if (rainfallMm < 1) return "Dry (rainfall screen)";
  if (rainfallMm <= 5) return "Wet (rainfall screen)";
  if (rainfallMm <= 20) return "Warning (rainfall screen)";
  return "Danger (rainfall screen)";
}

function heatTooltip(cell: IndiaWeatherHex, heatOffset: number) {
  const validAt = cell.validStart ? ` (forecast for ${new Date(cell.validStart).toLocaleString()})` : " (forecast)";
  return [
    `Current temperature: ${valueOrUnavailable(cell.airTemperatureC === null ? null : cell.airTemperatureC + heatOffset, " °C")}${validAt}`,
    `Feels like temperature: ${valueOrUnavailable(cell.feelsLikeC, " °C")}`,
    "Alert level: Unavailable (official area warning not connected)",
    `Wind speed: ${valueOrUnavailable(cell.windSpeedKmh, " km/h")}`,
    "UV index: Unavailable",
    "Air quality: Unavailable",
    "Surface temperature: Unavailable (no numeric satellite reading for this hex)",
  ].join("\n");
}

function floodTooltip(cell: Pick<IndiaWeatherHex, "airTemperatureC" | "relativeHumidityPct" | "rainfall24hMm">,
  localRunoff?: number | null, validStart?: string) {
  const status = localRunoff === undefined
    ? floodRainStatus(cell.rainfall24hMm)
    : localRunoff === null ? "No local runoff estimate"
      : `Terrain runoff screen ${localRunoff.toFixed(1)} mm (not observed flooding)`;
  const validAt = validStart ? ` (forecast for ${new Date(validStart).toLocaleString()})` : " (forecast)";
  return [
    `Status: ${status}`,
    "Water level: Unavailable (no colocated gauge data)",
    "Rate of rise: Unavailable (no gauge time series)",
    `Temperature (current): ${valueOrUnavailable(cell.airTemperatureC, " °C")}${validAt}`,
    `Humidity: ${valueOrUnavailable(cell.relativeHumidityPct, "%")}`,
    `Rainfall: ${valueOrUnavailable(cell.rainfall24hMm, " mm / 24 h forecast")}`,
  ].join("\n");
}

type IndiaWeatherHex = IndiaGridCell & Omit<IndiaHexWeather, "id">;
type CityFloodHover = HexSummary & { weather: IndiaWeatherHex | null };

export default function MapView({
  place, cityFlood, onReset, onCurrentLocation, drivePoints, drivingRoutes, selectedDrivingId, onPickPoint,
  navigation, assistant, weatherWidget, scenarioRoute, trafficSegments,
}: {
  place: MapPlace | null;
  cityFlood: Extract<CityFloodResponse, { status: "ready" }> | null;
  onReset: () => void;
  onCurrentLocation?: (location: LatLng) => void;
  drivePoints: Waypoints;
  drivingRoutes?: DrivingOption[];
  selectedDrivingId: string;
  onPickPoint?: (point: LatLng) => void;
  navigation: { mode: NavigationMode; location: LiveLocation | null; routeMatch: RouteMatch | null };
  assistant: ReactNode;
  weatherWidget: ReactNode;
  scenarioRoute?: ScenarioRouteExposure;
  trafficSegments?: DrivingOption["traffic_segments"];
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const driveMarker = useRef<maplibregl.Marker | null>(null);
  const [mapError, setMapError] = useState(false);
  const [detail, setDetail] = useState<MapDetail>("city");
  const [hexGrids, setHexGrids] = useState<HexGrids | null>(null);
  const [fineHexes, setFineHexes] = useState<HexCell[] | null>(null);
  const fineHexesRequest = useRef<AbortController | null>(null);
  const [indiaBoundary, setIndiaBoundary] = useState<IndiaBoundary | null>(null);
  const [viewBounds, setViewBounds] = useState<MapBounds | null>(null);
  const [viewZoom, setViewZoom] = useState(5);
  const [nationalWeather, setNationalWeather] = useState<IndiaHexWeather[]>([]);
  const [nationalWeatherLoading, setNationalWeatherLoading] = useState(false);
  const [nationalWeatherError, setNationalWeatherError] = useState<string | null>(null);
  const [roadScreen, setRoadScreen] = useState<{
    source: typeof cityFlood; segments: RoadRunoff[]; status: "ready" | "zoom" | "unavailable";
  } | null>(null);
  const result = useFloodStore((s) => s.simulateResult);
  const route = useFloodStore((s) => s.route);
  const selectedRoute = useFloodStore((s) => s.selectedRouteId);
  const selectNode = useFloodStore((s) => s.selectNode);
  const visibility = useFloodStore((s) => s.layerVisibility);
  const currentSurfaceTemperature = useRef(visibility.surfaceTemperature);
  currentSurfaceTemperature.current = visibility.surfaceTemperature;
  const heatOffset = useFloodStore((s) => s.heatOffsetC);
  const currentHeatOffset = useRef(heatOffset);
  currentHeatOffset.current = heatOffset;
  const nationalLayerActive = visibility.floodDepth || visibility.heat || visibility.combined;
  const centerLng = viewBounds ? (viewBounds[0][0] + viewBounds[1][0]) / 2 : null;
  const centerLat = viewBounds ? (viewBounds[0][1] + viewBounds[1][1]) / 2 : null;
  const inBengaluruView = viewZoom >= 10.5 && centerLng !== null && centerLat !== null
    && centerLng >= 77.39 && centerLng <= 77.85 && centerLat >= 12.57 && centerLat <= 13.21;
  const localFloodReady = visibility.floodDepth && Boolean(cityFlood);
  const bellandurDetailActive = Boolean(inBengaluruView && localFloodReady);
  const indiaGrid = useMemo(() => viewBounds && indiaBoundary && nationalLayerActive
    ? createIndiaHexGrid(viewBounds, viewZoom, indiaBoundary)
    : [], [indiaBoundary, nationalLayerActive, viewBounds, viewZoom]);
  const indiaWeatherHexes = useMemo(() => {
    const weatherById = new Map(nationalWeather.map((cell) => [cell.id, cell]));
    return indiaGrid.flatMap((cell) => {
      const weather = weatherById.get(cell.id);
      return weather ? [{ ...cell, ...weather }] : [];
    });
  }, [indiaGrid, nationalWeather]);
  const indiaRainHexes = useMemo(() => visibility.floodDepth
    ? indiaWeatherHexes.filter((cell) => cell.rainfall24hMm !== null)
    : [], [indiaWeatherHexes, visibility.floodDepth]);
  const indiaHeatHexes = useMemo(() => visibility.heat
    ? indiaWeatherHexes.filter((cell) => cell.airTemperatureC !== null)
    : [], [indiaWeatherHexes, visibility.heat]);
  const indiaCompoundHexes = useMemo(() => visibility.combined
    ? indiaWeatherHexes.filter((cell) => cell.airTemperatureC !== null && cell.rainfall24hMm !== null)
    : [], [indiaWeatherHexes, visibility.combined]);
  // Use the finest bundled mesh for local flood screening at close zoom.
  const mesh = detail === "cells"
    ? fineHexes ?? hexGrids?.district
    : hexGrids?.[detail];
  const selectedDrivingRoute = drivingRoutes?.find((option) => option.id === selectedDrivingId) ?? null;
  const navigationActive = navigation.mode !== "idle" && navigation.mode !== "error";
  const simulatedDrive = navigation.mode === "simulating" || navigation.mode === "arrived";
  const currentRoadScreen = visibility.cityRoads && roadScreen?.source === cityFlood ? roadScreen : null;
  const roadSegments = currentRoadScreen?.segments;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/india-boundary.geojson", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<IndiaBoundary> : null)
      .then((feature) => { if (feature) setIndiaBoundary(feature); })
      .catch(() => {});
    fetch("/data/bengaluru-hexes.json", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<HexGrids> : null)
      .then(setHexGrids)
      .catch(() => {
        // The source overlays are still usable if the display grid is missing.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!bellandurDetailActive || detail !== "cells" || fineHexes || fineHexesRequest.current) return;
    const controller = new AbortController();
    fineHexesRequest.current = controller;
    void fetch("/data/bengaluru-hexes-fine.json", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<HexCell[]> : null)
      .then((cells) => { if (cells && !controller.signal.aborted) setFineHexes(cells); })
      .catch(() => {})
      .finally(() => { if (fineHexesRequest.current === controller) fineHexesRequest.current = null; });
  }, [bellandurDetailActive, detail, fineHexes]);

  useEffect(() => () => fineHexesRequest.current?.abort(), []);

  const floodHexes = useMemo<CityFloodHover[]>(() => {
    if (!mesh || !visibility.floodDepth || !cityFlood || !bellandurDetailActive) return [];
    const values = new Map<string, number | null>();
    for (const cell of cityFlood.cells) {
      values.set(cell.id.split(":").slice(0, 2).join(":"), cell.screen_mm);
    }
    const weatherById = new Map(indiaWeatherHexes.map((cell) => [cell.id, cell]));
    return summarizeHexes(mesh, values).map((summary) => {
      const ring = summary.rings[0] ?? [];
      const center = ring.length ? {
        lng: ring.reduce((total, point) => total + point[0], 0) / ring.length,
        lat: ring.reduce((total, point) => total + point[1], 0) / ring.length,
      } : null;
      let nearest: IndiaWeatherHex | null = null;
      let nearestDistance = Infinity;
      if (center) for (const candidate of indiaWeatherHexes) {
        const distance = (candidate.center.lng - center.lng) ** 2 * Math.cos(center.lat * Math.PI / 180) ** 2
          + (candidate.center.lat - center.lat) ** 2;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = weatherById.get(candidate.id) ?? null;
        }
      }
      return { ...summary, weather: nearest };
    });
  }, [bellandurDetailActive, cityFlood, indiaWeatherHexes, mesh, visibility.floodDepth]);

  const hasMapOverlay = Boolean((visibility.floodDepth && (cityFlood || indiaRainHexes.length))
    || (visibility.heat && indiaHeatHexes.length) || (visibility.combined && indiaCompoundHexes.length)
    || visibility.surfaceTemperature);
  const hasHexes = floodHexes.length > 0 || indiaGrid.length > 0
    || indiaRainHexes.length > 0 || indiaHeatHexes.length > 0;

  useEffect(() => {
    if (!container.current) return;
    let instance: maplibregl.Map;
    try {
      instance = new maplibregl.Map({
        container: container.current,
        style: BASEMAP_STYLE,
        bounds: INDIA_BOUNDS,
        fitBoundsOptions: INDIA_VIEW,
        attributionControl: { compact: true },
      });
    } catch {
      setMapError(true);
      return;
    }
    map.current = instance;
    const updateView = () => {
      setViewBounds(instance.getBounds().toArray() as MapBounds);
      setViewZoom(instance.getZoom());
    };
    instance.on("moveend", updateView);
    instance.once("load", updateView);
    let currentDetail = getMapDetail(instance.getZoom());
    setDetail(currentDetail);
    instance.on("zoom", () => {
      const next = getMapDetail(instance.getZoom());
      if (next === currentDetail) return;
      currentDetail = next;
      setDetail(next);
    });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    instance.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
      trackUserLocation: true,
      showUserLocation: true,
      showAccuracyCircle: true,
    });
    geolocate.on("geolocate", (event) => onCurrentLocation?.({ lat: event.coords.latitude, lng: event.coords.longitude }));
    instance.addControl(geolocate, "bottom-right");
    const deckOverlay = new MapboxOverlay({
      layers: [],
      getTooltip: ({ object, layer }) => {
        if (!object) return null;
        switch (layer?.id) {
          case "flood-nodes":
            return `Simulated depth: ${(object.depth_m_mean * 100).toFixed(1)} cm\nModel spread: ±${(object.depth_m_std * 100).toFixed(1)} cm`;
          case "flood-roads":
            return `Simulated road class: ${String(object.state).replace("_", " ")}`;
          case "city-road-runoff":
            return `${object.name}\nCell runoff screen: ${object.runoffMm.toFixed(1)} mm\nScenario exposure on a 300 m grid`;
          case "driving-traffic":
            return TRAFFIC_LABELS[object.level as TrafficLevel];
          case "driving-scenario":
            return object.high ? "Scenario runoff above 20 mm in this cell band" : "Road crossing a screened runoff area in the rainfall scenario";
          case "india-heat-hexes":
            return heatTooltip(object as IndiaWeatherHex, currentHeatOffset.current);
          case "india-rain-hexes":
            return floodTooltip(object as IndiaWeatherHex, undefined, object.validStart);
          case "india-compound-hexes": {
            const cell = object as IndiaWeatherHex;
            return [
              "Flood",
              floodTooltip(cell, undefined, cell.validStart),
              "Heat",
              heatTooltip(cell, currentHeatOffset.current),
            ].join("\n");
          }
          case "city-flood":
            return floodTooltip({ airTemperatureC: null, relativeHumidityPct: null, rainfall24hMm: null },
              object.screen_mm);
          case "city-flood-hexes":
            return floodTooltip(object.weather ?? {
              airTemperatureC: null, relativeHumidityPct: null, rainfall24hMm: null,
            }, object.value, object.weather?.validStart);
          default:
            return null;
        }
      },
    });
    instance.addControl(deckOverlay, "top-left");
    overlay.current = deckOverlay;
    instance.once("error", () => {
      if (!instance.isStyleLoaded()) setMapError(true);
    });
    instance.once("load", () => {
      setMapError(false);
      if (!instance.getSource("surface-temperature-imagery")) {
        instance.addSource("surface-temperature-imagery", {
          type: "raster", tiles: [SURFACE_TEMPERATURE_TILES], tileSize: 256, maxzoom: 7,
          bounds: [68, 6, 98, 38],
          attribution: "Daily daytime land-surface temperature imagery: NASA EOSDIS GIBS / MODIS Terra",
        });
        const firstLabel = instance.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
        instance.addLayer({
          id: "surface-temperature-imagery",
          type: "raster",
          source: "surface-temperature-imagery",
          layout: { visibility: currentSurfaceTemperature.current ? "visible" : "none" },
          paint: { "raster-opacity": 0.78 },
        }, firstLabel);
      }
      if (!instance.getSource("india-state-boundaries")) {
        instance.addSource("india-state-boundaries", {
          type: "geojson",
          data: "/data/india-state-boundaries.geojson",
          attribution: "State outlines: geoBoundaries / DataMeet · CC BY 2.5 IN",
        });
        const firstLabel = instance.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
        instance.addLayer({
          id: "india-state-boundaries",
          type: "line",
          source: "india-state-boundaries",
          paint: { "line-color": "#536b7d", "line-opacity": 0.58, "line-width": 1.1 },
        }, firstLabel);
      }
    });

    return () => {
      driveMarker.current?.remove();
      driveMarker.current = null;
      instance.off("moveend", updateView);
      instance.remove();
      overlay.current = null;
      map.current = null;
    };
  }, [onCurrentLocation]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const updateVisibility = () => {
      if (instance.getLayer("surface-temperature-imagery")) {
        instance.setLayoutProperty("surface-temperature-imagery", "visibility",
          visibility.surfaceTemperature ? "visible" : "none");
      }
    };
    if (instance.isStyleLoaded()) updateVisibility();
    else instance.once("load", updateVisibility);
    return () => { instance.off("load", updateVisibility); };
  }, [visibility.surfaceTemperature]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || viewZoom < 5.8 || !instance.isStyleLoaded() || instance.getSource("india-district-boundaries")) return;
    instance.addSource("india-district-boundaries", {
      type: "geojson",
      data: "/data/india-district-boundaries.geojson",
      attribution: "District outlines: geoBoundaries · ODbL 1.0",
    });
    const firstLabel = instance.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
    instance.addLayer({
      id: "india-district-boundaries",
      type: "line",
      source: "india-district-boundaries",
      minzoom: 5.8,
      paint: { "line-color": "#738493", "line-opacity": 0.36, "line-width": 0.65 },
    }, firstLabel);
  }, [viewZoom]);

  useEffect(() => {
    if (!nationalLayerActive || !indiaGrid.length) {
      setNationalWeather([]);
      setNationalWeatherLoading(false);
      setNationalWeatherError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setNationalWeatherLoading(true);
      setNationalWeatherError(null);
      void loadIndiaHexWeather(indiaGrid, controller.signal, (data, unavailable) => {
        if (!controller.signal.aborted) {
          setNationalWeather(data);
          setNationalWeatherError(unavailable
            ? data.length
              ? `${unavailable.toLocaleString("en-IN")} India forecast cells are unavailable; showing available values.`
              : `The India-wide forecast is unavailable for all ${unavailable.toLocaleString("en-IN")} visible cells. Try again shortly.`
            : null);
        }
      })
        .then((data) => { if (!controller.signal.aborted) setNationalWeather(data); })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setNationalWeatherError(reason instanceof Error
              ? reason.message : "India-wide forecast cells could not load. Try again shortly.");
          }
        })
        .finally(() => { if (!controller.signal.aborted) setNationalWeatherLoading(false); });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [indiaGrid, nationalLayerActive]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    let live = true;
    const updateBuildings = () => {
      if (!live || !instance.isStyleLoaded()) return;
      const style = instance.getStyle();
      if (!navigationActive) {
        if (instance.getLayer("cityshield-drive-buildings")) instance.removeLayer("cityshield-drive-buildings");
        return;
      }
      const hasBuildings = Boolean(style.sources.protomaps && style.layers?.some((layer) =>
        "source" in layer && layer.source === "protomaps"
        && "source-layer" in layer && layer["source-layer"] === "buildings",
      ));
      if (!hasBuildings || instance.getLayer("cityshield-drive-buildings")) return;
      const extrusion: FillExtrusionLayerSpecification = {
        id: "cityshield-drive-buildings",
        type: "fill-extrusion",
        source: "protomaps",
        "source-layer": "buildings",
        minzoom: 14,
        paint: {
          "fill-extrusion-color": "#c9dce9",
          "fill-extrusion-height": ["max", 4, ["to-number", ["get", "height"], 8]],
          "fill-extrusion-base": ["max", 0, ["to-number", ["get", "min_height"], 0]],
          "fill-extrusion-opacity": 0.82,
        },
      };
      const firstLabel = style.layers?.find((layer) => layer.type === "symbol")?.id;
      instance.addLayer(extrusion, firstLabel);
    };
    if (instance.isStyleLoaded()) updateBuildings();
    else instance.once("style.load", updateBuildings);
    return () => {
      live = false;
      instance.off("style.load", updateBuildings);
    };
  }, [navigationActive]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const location = navigation.location;
    if (!navigationActive || !location) {
      driveMarker.current?.remove();
      driveMarker.current = null;
      instance.getContainer().querySelectorAll(".gps-navigation-marker").forEach((marker) => marker.remove());
      if (!navigationActive && navigation.mode === "idle") {
        const bounds = new maplibregl.LngLatBounds();
        for (const coordinate of selectedDrivingRoute?.coordinates ?? []) bounds.extend(coordinate);
        if (!bounds.isEmpty()) {
          instance.fitBounds(bounds, {
            padding: 50,
            maxZoom: 15,
            duration: 500,
          });
        } else {
          instance.easeTo({ pitch: 0, bearing: 0, duration: 400 });
        }
      }
      return;
    }
    if (!driveMarker.current) {
      const element = document.createElement("div");
      element.className = "gps-navigation-marker";
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", "Your current GPS location");
      element.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 27 27l-11-6-11 6L16 2Z"/></svg>';
      driveMarker.current = new maplibregl.Marker({
        element,
        anchor: "center",
        rotationAlignment: "map",
        pitchAlignment: "map",
      }).setLngLat([location.lng, location.lat]).addTo(instance);
    }
    driveMarker.current.getElement().setAttribute("aria-label", simulatedDrive ? "Simulated car location" : "Your current GPS location");
    const bearing = location.heading_deg ?? navigation.routeMatch?.bearing ?? 0;
    driveMarker.current.setLngLat([location.lng, location.lat]);
    if (navigation.mode === "arrived") return;
    driveMarker.current.setRotation(bearing);
    instance.easeTo({
      center: [location.lng, location.lat],
      zoom: 16.5,
      pitch: 55,
      bearing,
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
    });
  }, [navigationActive, navigation.location, navigation.mode, navigation.routeMatch?.bearing, selectedDrivingRoute, simulatedDrive]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (place) {
      const [west, south, east, north] = place.bounds;
      instance.fitBounds([[west, south], [east, north]], { ...AREA_VIEW, duration: 0 });
      const dot = document.createElement("div");
      dot.className = "place-marker";
      dot.setAttribute("aria-hidden", "true");
      const marker = new maplibregl.Marker({ element: dot }).setLngLat(place.center).addTo(instance);
      return () => {
        marker.remove();
      };
    } else {
      instance.fitBounds(INDIA_BOUNDS, INDIA_VIEW);
    }
  }, [place]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !onPickPoint) return;
    const canvas = instance.getCanvas();
    const onClick = (event: maplibregl.MapMouseEvent) => {
      onPickPoint({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    };
    canvas.style.cursor = "crosshair";
    instance.on("click", onClick);
    return () => {
      instance.off("click", onClick);
      canvas.style.cursor = "";
    };
  }, [onPickPoint]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const markers: maplibregl.Marker[] = [];
    for (const [index, point] of [drivePoints.source, drivePoints.destination].entries()) {
      if (!point || (index === 0 && navigationActive)) continue;
      const marker = document.createElement("div");
      marker.className = `route-marker marker-${index}`;
      marker.textContent = index === 0 ? "A" : "B";
      marker.setAttribute("aria-label", `${index === 0 ? "Source" : "Destination"}: ${point.name}`);
      markers.push(new maplibregl.Marker({ element: marker }).setLngLat([point.lng, point.lat]).addTo(instance));
    }
    return () => markers.forEach((marker) => marker.remove());
  }, [drivePoints, navigationActive]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !drivingRoutes?.length || navigationActive) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const option of drivingRoutes) {
      for (const coordinate of option.coordinates) bounds.extend(coordinate);
    }
    if (!bounds.isEmpty()) {
      instance.fitBounds(bounds, {
        padding: 50,
        maxZoom: 15,
        duration: 0,
      });
    }
  }, [drivingRoutes, navigationActive]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !visibility.cityRoads || !cityFlood) return;
    const screen = createRoadRunoffScreen(cityFlood.cells);
    let lastView = "";
    function updateScreen() {
      if (!instance || !instance.isStyleLoaded() || !instance.areTilesLoaded() || instance.isMoving()) return;
      const view = [instance.getBounds().toArray(), instance.getZoom(), instance.getPitch(), instance.getBearing()].join("|");
      if (view === lastView) return;
      lastView = view;
      const roadLayers = (instance.getStyle().layers ?? []).filter((layer) =>
        layer.type === "line" && "source-layer" in layer && (
          (layer["source-layer"] === "roads" && /^road_.*_case/.test(layer.id)) ||
          layer["source-layer"] === "transportation"
        )).map((layer) => layer.id);
      const status = instance.getZoom() < ROAD_SCREEN_MIN_ZOOM ? "zoom" : roadLayers.length ? "ready" : "unavailable";
      const segments = status === "ready" ? screen(instance.queryRenderedFeatures({ layers: roadLayers })) : [];
      setRoadScreen({ source: cityFlood, segments, status });
    }
    updateScreen();
    instance.on("idle", updateScreen);
    return () => { instance.off("idle", updateScreen); };
  }, [cityFlood, visibility.cityRoads]);

  useEffect(() => {
    const layers: Layer[] = [];
    if (indiaHeatHexes.length) {
      layers.push(new PolygonLayer<IndiaWeatherHex>({
        id: "india-heat-hexes",
        data: indiaHeatHexes,
        getPolygon: (cell) => cell.rings,
        getFillColor: (cell) => temperatureColor((cell.airTemperatureC ?? 0) + heatOffset),
        getLineColor: [255, 255, 255, 190],
        lineWidthMinPixels: 1,
        pickable: true,
        updateTriggers: { getFillColor: heatOffset },
      }));
    }
    const loadedIndiaIds = new Set(nationalWeather.map((cell) => cell.id));
    const unfilledIndiaCells = indiaGrid.filter((cell) => !loadedIndiaIds.has(cell.id));
    if (unfilledIndiaCells.length && nationalLayerActive && nationalWeatherLoading) {
      layers.push(new PolygonLayer<IndiaGridCell>({
        id: "india-hex-grid-loading",
        data: unfilledIndiaCells,
        getPolygon: (cell) => cell.rings,
        stroked: true,
        getFillColor: [0, 0, 0, 0],
        getLineColor: [91, 119, 137, 90],
        lineWidthMinPixels: 0.7,
        pickable: false,
      }));
    }
    if (indiaRainHexes.length) {
      layers.push(new PolygonLayer<IndiaWeatherHex>({
        id: "india-rain-hexes",
        data: indiaRainHexes,
        getPolygon: (cell) => cell.rings,
        getFillColor: (cell) => rainfallProxyColor(cell.rainfall24hMm ?? 0),
        getLineColor: [46, 86, 117, 160],
        lineWidthMinPixels: 1,
        pickable: true,
      }));
    }
    if (indiaCompoundHexes.length) {
      layers.push(new PolygonLayer<IndiaWeatherHex>({
        id: "india-compound-hexes",
        data: indiaCompoundHexes,
        getPolygon: (cell) => cell.rings,
        getFillColor: (cell) => {
          const rain = cell.rainfall24hMm ?? 0;
          const temperature = (cell.airTemperatureC ?? -100) + heatOffset;
          return rain >= 20 && temperature >= 35 ? [112, 55, 142, 200] : [177, 187, 201, 70];
        },
        getLineColor: [255, 255, 255, 190],
        lineWidthMinPixels: 1,
        pickable: true,
        updateTriggers: { getFillColor: heatOffset },
      }));
    }
    if (floodHexes.length) {
      layers.push(new PolygonLayer<CityFloodHover>({
        id: "city-flood-hexes",
        data: floodHexes,
        getPolygon: (cell) => cell.rings,
        getFillColor: (cell) => floodScreenColor(cell.value),
        getLineColor: [46, 86, 117, 140],
        lineWidthMinPixels: 1,
        pickable: true,
      }));
    } else if (visibility.floodDepth && cityFlood) {
      layers.push(new PolygonLayer<CityFloodCell>({
        id: "city-flood",
        data: cityFlood.cells,
        getPolygon: (cell) => cell.rings,
        getFillColor: (cell) => floodScreenColor(cell.screen_mm),
        stroked: false,
        pickable: true,
      }));
    }
    if (roadSegments?.length) {
      layers.push(new PathLayer<RoadRunoff>({
        id: "city-road-runoff",
        data: roadSegments,
        getPath: (segment) => segment.path,
        getColor: (segment) => RUNOFF_COLORS[segment.runoffMm > 20 ? 2 : segment.runoffMm > 5 ? 1 : 0],
        getWidth: 3,
        widthUnits: "pixels",
        pickable: true,
      }));
    }
    if (visibility.pilotFlood && result) {
      layers.push(new PathLayer<RoadSegment>({
        id: "flood-roads",
        data: result.road_segments,
        getPath: (segment) => segment.geometry.coordinates,
        getColor: (segment) => ROAD_COLORS[segment.state],
        getWidth: (segment) => segment.state === "clear" ? 1.5 : 3.5,
        widthUnits: "pixels",
        pickable: true,
      }));
      layers.push(new ScatterplotLayer<NodePrediction>({
        id: "flood-nodes",
        data: result.node_predictions,
        getPosition: (node) => [node.lng, node.lat],
        getRadius: 3,
        radiusUnits: "pixels",
        getFillColor: (node) => depthColor(node.depth_m_mean),
        pickable: true,
        onClick: ({ object }) => {
          if (object) selectNode((object as NodePrediction).node_id);
          return Boolean(object);
        },
      }));
    }
    if (route && !drivingRoutes?.length) {
      const routes = [
        { id: "shortest", path: route.baseline_route_geometry?.coordinates, color: [92, 105, 120] as const },
        { id: "recommended", path: route.route_geometry?.coordinates, color: [36, 119, 168] as const },
      ];
      const alternate = route.routes?.find((option) => option.id === selectedRoute);
      if (alternate && !routes.some((option) => option.id === alternate.id)) {
        layers.push(new PathLayer({
          id: "route-alternate",
          data: [{ path: alternate.geometry.coordinates }],
          getPath: (item) => item.path,
          getColor: [129, 78, 180],
          getWidth: 5,
          widthUnits: "pixels",
        }));
      }
      for (const option of routes) {
        if (!option.path?.length) continue;
        layers.push(new PathLayer({
          id: `route-${option.id}`,
          data: [{ path: option.path }],
          getPath: (item) => item.path,
          getColor: [...option.color, selectedRoute === option.id ? 255 : 110],
          getWidth: selectedRoute === option.id ? 5 : 2,
          widthUnits: "pixels",
        }));
      }
    }
    if (drivingRoutes?.length) {
      const selected = drivingRoutes.find((option) => option.id === selectedDrivingId);
      const paths = drivingRoutes.filter((option) => option !== selected);
      if (selected) paths.push(selected);
      layers.push(new PathLayer<DrivingOption>({
        id: "driving-route-options",
        data: paths,
        getPath: (option) => option.coordinates,
        getColor: (option) => option.id === selectedDrivingId ? TRAFFIC_COLORS.unknown : [87, 104, 140, 140],
        getWidth: (option) => option.id === selectedDrivingId ? 7 : 4,
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getColor: selectedDrivingId, getWidth: selectedDrivingId },
      }));
      if (selected && scenarioRoute?.spans.length) {
        const distances = routeVertexDistances(selected.coordinates);
        const paths = (spans: ScenarioRouteExposure["spans"], high: boolean) => spans.map(({ start, end }) => ({
          high, coordinates: pathForFraction(selected.coordinates, distances, start, end),
        }));
        layers.push(new PathLayer<{ high: boolean; coordinates: DrivingOption["coordinates"] }>({
          id: "driving-scenario",
          data: [...paths(scenarioRoute.spans, false), ...paths(scenarioRoute.high_spans, true)],
          getPath: (span) => span.coordinates,
          getColor: (span) => [...RUNOFF_COLORS[span.high ? 2 : 0], 220],
          getWidth: 15,
          widthUnits: "pixels",
          pickable: true,
          jointRounded: true,
        }));
        layers.push(new PathLayer<DrivingOption>({
          id: "scenario-route-centerline", data: [selected], getPath: (option) => option.coordinates,
          getColor: TRAFFIC_COLORS.unknown, getWidth: 7, widthUnits: "pixels", jointRounded: true,
        }));
      }
      const traffic = trafficSegments ?? selected?.traffic_segments;
      if (selected && traffic?.length) {
        layers.push(new PathLayer<{ level: TrafficLevel; coordinates: DrivingOption["coordinates"] }>({
          id: "driving-traffic",
          data: traffic.map((span) => ({
            level: span.level,
            coordinates: selected.coordinates.slice(span.start_index, span.end_index + 1),
          })),
          getPath: (span) => span.coordinates,
          getColor: (span) => TRAFFIC_COLORS[span.level],
          getWidth: 7,
          widthUnits: "pixels",
          pickable: true,
          jointRounded: true,
        }));
      }
    }
    overlay.current?.setProps({ layers });
  }, [cityFlood, floodHexes, indiaGrid, indiaHeatHexes, indiaRainHexes, indiaCompoundHexes, nationalLayerActive, nationalWeather,
    nationalWeatherLoading,
    result, route, selectedRoute, visibility, drivingRoutes, selectedDrivingId, heatOffset, roadSegments,
    scenarioRoute, trafficSegments, selectNode]);

  return (
    <>
      <div className="map-frame">
        <div ref={container} className="map-canvas" aria-label="Interactive India map" />
        {mapError && <p className="map-status" role="status">Basemap unavailable. Check your connection or browser graphics support.</p>}
        <button className="map-reset" type="button" aria-label="View all India" title="View all India"
          onClick={() => { onReset(); map.current?.fitBounds(INDIA_BOUNDS, INDIA_VIEW); }}>
          <Icon name="extent" /><span>View all India</span>
        </button>
      </div>
      <div className="map-footer">{assistant}</div>
      <aside className="map-info-rail" aria-label="Forecast and map information">
        <div className="map-weather">{weatherWidget}</div>
        <section className="map-legend" aria-labelledby="legend-title">
          <div className="legend-heading">
            <h3 id="legend-title">Map legend</h3>
            {hasMapOverlay && <strong className="map-detail" role="status">
              {visibility.surfaceTemperature && !nationalLayerActive ? "Satellite surface-temperature imagery"
                : indiaGrid.length ? nationalWeatherLoading ? "India forecast hexes · loading values"
                : nationalWeatherError ? nationalWeather.length
                  ? "India forecast hexes · partial coverage" : "India hex grid · forecast unavailable"
                  : "India forecast hexes"
                : hasHexes ? detail === "city" ? "City hexagons · averages" : "District hexagons · averages"
                  : "Waiting for layer data"}
            </strong>}
          </div>
          <p className="coverage-note">India state outlines show at all zooms; district outlines appear as you zoom in. Districts are not exact city limits.</p>
          {nationalLayerActive && nationalWeatherLoading && <p className="coverage-note" role="status">Loading India-wide weather cells…</p>}
          {nationalWeatherError && <p className="coverage-note" role="alert">{nationalWeatherError}</p>}
          {visibility.floodDepth && indiaRainHexes.length > 0 && <div className="flood-legend">
            <strong>24-hour forecast accumulation</strong>
            {[
              { label: "<1 mm", color: RAINFALL_PROXY_COLORS[0] },
              { label: "1–5 mm", color: RAINFALL_PROXY_COLORS[2] },
              { label: ">5–20 mm", color: RAINFALL_PROXY_COLORS[5] },
              { label: ">20 mm", color: RAINFALL_PROXY_COLORS[7] },
            ].map(({ label, color }) => (
              <span key={label}><i style={rainfallSwatchStyle(color, color === RAINFALL_PROXY_COLORS[0] ? 100 : 185)} />{label}</span>
            ))}
          </div>}
          {visibility.floodDepth && cityFlood && <div className="flood-legend">
            <strong>Runoff on terrain depressions</strong>
            {FLOOD_LEGEND.map(({ label, color }) => (
              <span key={label}><i style={{ background: `rgb(${color.join(",")})` }} /> {label}</span>
            ))}
          </div>}
          {visibility.pilotFlood && <>
            <span><i className="road-segment-swatch" /> Simulated road segments · risk-colored</span>
            <span><i style={{ background: "#507cb3" }} /> Depth &lt;15 cm</span>
            <span><i style={{ background: "#b16720" }} /> 15–30 cm</span>
            <span><i style={{ background: "#af2d30" }} /> &gt;30 cm</span>
          </>}
          {visibility.cityRoads && <div className="flood-legend">
            <strong>Mapped roads in screened cells</strong>
            {roadSegments?.length ? RUNOFF_COLORS.map((color, index) => <span key={index}>
              <i style={{ background: `rgb(${color.join(",")})` }} />{["1–5 mm", ">5–20 mm", ">20 mm"][index]}
            </span>) : <span>{mapError || currentRoadScreen?.status === "unavailable" ? "Road geometry unavailable."
              : currentRoadScreen?.status === "zoom" ? "Zoom in to see road screening."
                : currentRoadScreen?.status === "ready" ? "No mapped road crossings above the screening threshold in this view."
                  : cityFlood ? "Screening visible roads…" : "Waiting for city runoff data…"}</span>}
          </div>}
          {selectedDrivingRoute && <div className="flood-legend">
            <strong>Selected route traffic</strong>
            {(["clear", "slow", "heavy", "unknown"] as const).map((level) => <span key={level}><i style={{ background: `rgb(${TRAFFIC_COLORS[level].join(",")})` }} />{TRAFFIC_LABELS[level]}</span>)}
            {scenarioRoute && <span><i style={{ background: `rgb(${RUNOFF_COLORS[0].join(",")})` }} />Scenario runoff along route</span>}
          </div>}
          {visibility.heat && indiaHeatHexes.length > 0 && <span><i className="heat-scale" style={temperatureLegendStyle()} /> 2 m air-temperature forecast</span>}
          {visibility.surfaceTemperature && <p className="coverage-note">Daily daytime satellite surface-temperature imagery · latest available scene · cloud gaps may appear. This is land-surface temperature, not air temperature or a forecast.</p>}
          {visibility.combined && <div className="flood-legend">
            <strong>Combined exposure screening</strong>
            <span><i style={{ background: "rgb(112,55,142)" }} />Rain ≥20 mm and air temperature ≥35 °C</span>
            <span><i style={{ background: "rgb(177,187,201)" }} />Below one or both screening thresholds</span>
            <p className="coverage-note">Illustrative overlap screen only; thresholds are not locally calibrated and do not represent a probability or official alert.</p>
          </div>}
          {nationalLayerActive && <p className="coverage-note">India-wide numerical forecast data at 0.25° resolution: heat shows 2 m air temperature at every zoom, never satellite land-surface temperature. Display hex sizes adapt to map zoom; closer zoom does not add forecast resolution. Accumulated precipitation is a screening proxy, not inundation depth. Validity window and model run are available on each hex. Boundary and basemap: © OpenStreetMap contributors.</p>}
          {!nationalLayerActive && !visibility.surfaceTemperature && <p className="coverage-note">Turn on Flood or Heat to show India-wide forecast hexes. Local flood screening is available for the Bengaluru study area.</p>}
        </section>
      </aside>
    </>
  );
}
