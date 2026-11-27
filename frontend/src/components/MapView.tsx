import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Layer } from "@deck.gl/core";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import type { FillExtrusionLayerSpecification } from "maplibre-gl";
import type { CityFloodCell, CityFloodResponse, DrivingOption, ExposureCell, LatLng, NodePrediction, RoadSegment, ScenarioRouteExposure, TrafficLevel } from "../api/client";
import { getMapDetail, summarizeHexes, summarizeHexPoints, type HexGrids, type HexSummary, type MapDetail } from "../map/hexGrid";
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
const CITY_BOUNDS: maplibregl.LngLatBoundsLike = [[77.44, 12.62], [77.80, 13.16]];
const CITY_VIEW = { padding: 30, duration: 0 };
const ROAD_COLORS = {
  clear: [80, 124, 179],
  at_risk: [177, 103, 32],
  flooded: [175, 45, 48],
} satisfies Record<RoadSegment["state"], [number, number, number]>;
const RUNOFF_COLORS: [number, number, number][] = [[119, 66, 179], [145, 28, 145], [97, 18, 85]];
const TRAFFIC_COLORS = {
  clear: [34, 106, 217],
  slow: [239, 178, 20],
  heavy: [208, 42, 42],
  unknown: [97, 111, 135],
} satisfies Record<TrafficLevel, [number, number, number]>;
const TRAFFIC_LABELS: Record<TrafficLevel, string> = {
  clear: "No delay reported", slow: "Slow traffic", heavy: "Heavy delay or closure", unknown: "No segment detail",
};

const FLOOD_LEGEND = [
  { label: "0 mm", color: [210, 231, 242] },
  { label: ">0–5 mm", color: [120, 182, 218] },
  { label: ">5–20 mm", color: [48, 120, 185] },
  { label: ">20 mm", color: [19, 58, 111] },
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
  const weight = Math.max(0, Math.min(1, (temperature - 25) / 20));
  return [Math.round(250 - 75 * weight), Math.round(210 - 175 * weight), Math.round(131 - 70 * weight), 178];
}

export default function MapView({
  place, cityHeat, cityFlood, onReset, drivePoints, drivingRoutes, selectedDrivingId, onPickPoint,
  navigation, assistant, scenarioRoute, trafficSegments,
}: {
  place: MapPlace | null;
  cityHeat: CityHeat | null;
  cityFlood: Extract<CityFloodResponse, { status: "ready" }> | null;
  onReset: () => void;
  drivePoints: Waypoints;
  drivingRoutes?: DrivingOption[];
  selectedDrivingId: string;
  onPickPoint?: (point: LatLng) => void;
  navigation: { mode: NavigationMode; location: LiveLocation | null; routeMatch: RouteMatch | null };
  assistant: ReactNode;
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
  const [roadScreen, setRoadScreen] = useState<{
    source: typeof cityFlood; segments: RoadRunoff[]; status: "ready" | "zoom" | "unavailable";
  } | null>(null);
  const result = useFloodStore((s) => s.simulateResult);
  const heat = useFloodStore((s) => s.heatData);
  const exposure = useFloodStore((s) => s.combinedExposure);
  const route = useFloodStore((s) => s.route);
  const selectedRoute = useFloodStore((s) => s.selectedRouteId);
  const visibility = useFloodStore((s) => s.layerVisibility);
  const heatOffset = useFloodStore((s) => s.heatOffsetC);
  const currentHeatOffset = useRef(heatOffset);
  currentHeatOffset.current = heatOffset;
  // Use the finest bundled hex mesh at close zoom; switching to source points
  // here made the heat layer change from hexagons to circles while zooming.
  const mesh = hexGrids?.[detail === "cells" ? "district" : detail];
  const selectedDrivingRoute = drivingRoutes?.find((option) => option.id === selectedDrivingId) ?? null;
  const navigationActive = navigation.mode !== "idle" && navigation.mode !== "error";
  const simulatedDrive = navigation.mode === "simulating" || navigation.mode === "arrived";
  const currentRoadScreen = visibility.cityRoads && roadScreen?.source === cityFlood ? roadScreen : null;
  const roadSegments = currentRoadScreen?.segments;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/bengaluru-hexes.json", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<HexGrids> : null)
      .then(setHexGrids)
      .catch(() => {
        // The source overlays are still usable if the display grid is missing.
      });
    return () => controller.abort();
  }, []);

  const floodHexes = useMemo(() => {
    if (!mesh || !visibility.floodDepth || !cityFlood) return [];
    const values = new Map<string, number | null>();
    for (const cell of cityFlood.cells) {
      values.set(cell.id.split(":").slice(0, 2).join(":"), cell.screen_mm);
    }
    return summarizeHexes(mesh, values);
  }, [cityFlood, mesh, visibility.floodDepth]);

  const heatHexes = useMemo(() => {
    if (!mesh || !visibility.heat) return [];
    if (!cityHeat && heat?.status === "ready") {
      return summarizeHexPoints(mesh, heat.cells.map((cell) => ({
        lng: cell.lng,
        lat: cell.lat,
        value: cell.temperature_c,
      })));
    }
    if (!cityHeat) return [];
    const values = new Map<string, number>();
    for (const [, , temperature, key] of cityHeat.cells) {
      if (key) values.set(key, temperature);
    }
    return summarizeHexes(mesh, values);
  }, [cityHeat, heat, mesh, visibility.heat]);

  const hasCityOverlay = Boolean((visibility.floodDepth && cityFlood)
    || (visibility.heat && (cityHeat || heat?.status === "ready")));
  const hasHexes = floodHexes.length > 0 || heatHexes.length > 0;

  useEffect(() => {
    if (!container.current) return;
    let instance: maplibregl.Map;
    try {
      instance = new maplibregl.Map({
        container: container.current,
        style: BASEMAP_STYLE,
        bounds: CITY_BOUNDS,
        fitBoundsOptions: CITY_VIEW,
        attributionControl: { compact: true },
      });
    } catch {
      setMapError(true);
      return;
    }
    map.current = instance;
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
    instance.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
      trackUserLocation: true,
      showUserLocation: true,
      showAccuracyCircle: true,
    }), "bottom-right");
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
          case "landsat-pixels":
            return `Surface temperature: ${(object.temperature_c + currentHeatOffset.current).toFixed(1)} °C`;
          case "city-heat":
            return `Modelled mean surface temperature: ${(object[2] + currentHeatOffset.current).toFixed(1)} °C`;
          case "city-heat-hexes":
            return `Mean surface temperature: ${(object.value + currentHeatOffset.current).toFixed(1)} °C\n${object.count} source cells`;
          case "city-flood":
            return object.screen_mm === null
              ? "Mapped permanent water. Excluded from land screening."
              : `Runoff on terrain depressions: ${object.screen_mm.toFixed(1)} mm (cell average)\nLand in terrain depressions: ${object.depressed_land_percent}%`;
          case "city-flood-hexes":
            return object.value === null
              ? "Only mapped permanent water in the available cells."
              : `Mean runoff on terrain depressions: ${object.value.toFixed(1)} mm\n${object.count} source cells`;
          case "both-elevated":
            return `Simulated depth: ${(object.flood_depth_m * 100).toFixed(1)} cm\nSurface temperature: ${(object.lst_c + currentHeatOffset.current).toFixed(1)} °C`;
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
    });

    return () => {
      driveMarker.current?.remove();
      driveMarker.current = null;
      instance.remove();
      overlay.current = null;
      map.current = null;
    };
  }, []);

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
      instance.fitBounds(CITY_BOUNDS, CITY_VIEW);
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
    if (heatHexes.length) {
      layers.push(new PolygonLayer<HexSummary>({
        id: "city-heat-hexes",
        data: heatHexes,
        getPolygon: (cell) => cell.rings,
        getFillColor: (cell) => temperatureColor((cell.value ?? 0) + heatOffset),
        getLineColor: [255, 255, 255, 215],
        lineWidthMinPixels: 1,
        pickable: true,
        updateTriggers: { getFillColor: heatOffset },
      }));
    }
    if (floodHexes.length) {
      layers.push(new PolygonLayer<HexSummary>({
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
      }));
    }
    if (visibility.combined && exposure?.status === "ready") {
      layers.push(new ScatterplotLayer<ExposureCell>({
        id: "both-elevated",
        data: exposure.cells.filter((cell) => cell.both_elevated),
        getPosition: (cell) => [cell.lng, cell.lat],
        getRadius: exposure.grid_resolution_m / 2,
        radiusMinPixels: 4,
        getFillColor: [129, 78, 180, 230],
        getLineColor: [255, 255, 255],
        lineWidthMinPixels: 1,
        stroked: true,
        pickable: true,
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
  }, [cityFlood, heatHexes, floodHexes, exposure, result, route, selectedRoute, visibility, drivingRoutes, selectedDrivingId, heatOffset, roadSegments, scenarioRoute, trafficSegments]);

  return (
    <>
      <div className="map-frame">
        <div ref={container} className="map-canvas" aria-label="Interactive India map" />
        {mapError && <p className="map-status" role="status">Basemap unavailable. Check your connection or browser graphics support.</p>}
        <button className="map-reset" type="button" aria-label="View whole city" title="View whole city"
          onClick={() => { onReset(); map.current?.fitBounds(CITY_BOUNDS, CITY_VIEW); }}>
          <Icon name="extent" /><span>View whole city</span>
        </button>
      </div>
      <div className="map-footer">
        {assistant}
        <section className="map-legend" aria-labelledby="legend-title">
          <div className="legend-heading">
            <h3 id="legend-title">Map legend</h3>
            {hasCityOverlay && <strong className="map-detail" role="status">
              {hasHexes ? (detail === "city" ? "City hexagons · averages" : "District hexagons · averages") : "300 m cells"}
            </strong>}
          </div>
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
          {visibility.heat && <span><i className="heat-scale" /> Surface temperature · 25–45 °C{heatOffset !== 0 &&
            ` · ${heatOffset > 0 ? "+" : ""}${heatOffset} °C scenario offset`}</span>}
          {visibility.combined && <span><i style={{ background: "#814eb4" }} /> Depth ≥15 cm + heat top 10%</span>}
          <p className="coverage-note">Flood and heat layers cover the 2025 GBA boundary. Beyond it, the map and routing remain available.</p>
        </section>
      </div>
    </>
  );
}
