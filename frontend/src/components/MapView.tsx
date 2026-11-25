import { useEffect, useMemo, useRef, useState } from "react";
import type { Layer } from "@deck.gl/core";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import type { FillExtrusionLayerSpecification } from "maplibre-gl";
import type { CityFloodCell, CityFloodResponse, DrivingOption, ExposureCell, HeatCell, LatLng, NodePrediction, RoadSegment } from "../api/client";
import { getMapDetail, summarizeHexes, type HexGrids, type HexSummary, type MapDetail } from "../map/hexGrid";
import { useFloodStore } from "../store/useFloodStore";
import type { BengaluruPlace } from "./PlaceSearch";
import { getRoutePosition, type DrivePreviewMode, type Waypoints } from "../map/drivingPlanner";

export interface CityHeat {
  scene_id: string;
  date: string;
  resolution_m: number;
  valid_pixel_fraction: number;
  rmse_c: number;
  cells: [lng: number, lat: number, temperature: number, gridKey?: string][];
}

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const DEFAULT_BBOX = [77.655, 12.915, 77.680, 12.940];
const PILOT_VIEW = { padding: 48, maxZoom: 14.2 };
const CITY_BOUNDS: maplibregl.LngLatBoundsLike = [[77.46005, 12.83362], [77.78437, 13.14266]];
const CITY_VIEW = { padding: 30, duration: 0 };
const ROAD_COLORS = {
  clear: [80, 124, 179],
  at_risk: [177, 103, 32],
  flooded: [175, 45, 48],
} satisfies Record<RoadSegment["state"], [number, number, number]>;

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

function pilotBounds(): [[number, number], [number, number]] {
  const configured = import.meta.env.VITE_PILOT_BBOX?.split(",").map(Number);
  const [west, south, east, north] =
    configured?.length === 4 && configured.every(Number.isFinite) ? configured : DEFAULT_BBOX;
  return [[west, south], [east, north]];
}

function depthColor(depth: number): [number, number, number, number] {
  const color = depth > 0.30 ? ROAD_COLORS.flooded : depth >= 0.15 ? ROAD_COLORS.at_risk : ROAD_COLORS.clear;
  return [...color, 235];
}

function heatColor(cell: HeatCell): [number, number, number, number] {
  return temperatureColor(cell.temperature_c);
}

function temperatureColor(temperature: number): [number, number, number, number] {
  const weight = Math.max(0, Math.min(1, (temperature - 25) / 20));
  return [Math.round(250 - 75 * weight), Math.round(210 - 175 * weight), Math.round(131 - 70 * weight), 178];
}

export default function MapView({
  place, cityHeat, cityFlood, onReset, drivePoints, drivingRoutes, selectedDrivingId, onPickPoint,
  drivePreview,
}: {
  place: BengaluruPlace | null;
  cityHeat: CityHeat | null;
  cityFlood: Extract<CityFloodResponse, { status: "ready" }> | null;
  onReset: () => void;
  drivePoints: Waypoints;
  drivingRoutes?: DrivingOption[];
  selectedDrivingId: string;
  onPickPoint?: (point: LatLng) => void;
  drivePreview: { mode: DrivePreviewMode; progress: number };
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const driveMarker = useRef<maplibregl.Marker | null>(null);
  const [mapError, setMapError] = useState(false);
  const [detail, setDetail] = useState<MapDetail>("city");
  const [hexGrids, setHexGrids] = useState<HexGrids | null>(null);
  const result = useFloodStore((s) => s.simulateResult);
  const heat = useFloodStore((s) => s.heatData);
  const exposure = useFloodStore((s) => s.combinedExposure);
  const route = useFloodStore((s) => s.route);
  const selectedRoute = useFloodStore((s) => s.selectedRouteId);
  const visibility = useFloodStore((s) => s.layerVisibility);
  const mesh = detail === "cells" ? null : hexGrids?.[detail];
  const selectedDrivingRoute = drivingRoutes?.find((option) => option.id === selectedDrivingId) ?? null;
  const previewPosition = useMemo(() => drivePreview.mode === "idle" || !selectedDrivingRoute
    ? null
    : getRoutePosition(selectedDrivingRoute.coordinates, drivePreview.progress),
  [drivePreview.mode, drivePreview.progress, selectedDrivingRoute]);

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
    if (!mesh || !visibility.heat || !cityHeat) return [];
    const values = new Map<string, number>();
    for (const [, , temperature, key] of cityHeat.cells) {
      if (key) values.set(key, temperature);
    }
    return summarizeHexes(mesh, values);
  }, [cityHeat, mesh, visibility.heat]);

  const hasCityOverlay = Boolean((visibility.floodDepth && cityFlood) || (visibility.heat && cityHeat));
  const hasHexes = floodHexes.length > 0 || heatHexes.length > 0;

  useEffect(() => {
    if (!container.current) return;
    const bounds = pilotBounds();
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
          case "landsat-pixels":
            return `Surface temperature: ${object.temperature_c.toFixed(1)} °C`;
          case "city-heat":
            return `Modelled mean surface temperature: ${object[2].toFixed(1)} °C`;
          case "city-heat-hexes":
            return `Mean surface temperature: ${object.value.toFixed(1)} °C\n${object.count} source cells`;
          case "city-flood":
            return object.screen_mm === null
              ? "Mapped permanent water. Excluded from land screening."
              : `Runoff on terrain depressions: ${object.screen_mm.toFixed(1)} mm (cell average)\nLand in terrain depressions: ${object.depressed_land_percent}%`;
          case "city-flood-hexes":
            return object.value === null
              ? "Only mapped permanent water in the available cells."
              : `Mean runoff on terrain depressions: ${object.value.toFixed(1)} mm\n${object.count} source cells`;
          case "both-elevated":
            return `Simulated depth: ${(object.flood_depth_m * 100).toFixed(1)} cm\nSurface temperature: ${object.lst_c.toFixed(1)} °C`;
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
      instance.addSource("city-boundary", {
        type: "geojson",
        data: "/data/bengaluru-boundary.geojson",
        attribution: "GBA delimitation via OpenCity and bharatlas",
      });
      instance.addLayer({
        id: "city-boundary",
        type: "line",
        source: "city-boundary",
        paint: { "line-color": "#164f46", "line-width": 2 },
      });
      const [[west, south], [east, north]] = bounds;
      instance.addSource("pilot-area", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
          },
        },
      });
      instance.addLayer({
        id: "pilot-area-boundary",
        type: "line",
        source: "pilot-area",
        paint: { "line-color": "#354852", "line-width": 1.5, "line-dasharray": [3, 2] },
      });
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
      if (drivePreview.mode === "idle") {
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
          "fill-extrusion-color": "#c9d8d1",
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
  }, [drivePreview.mode]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (drivePreview.mode === "idle" || !previewPosition || !selectedDrivingRoute) {
      driveMarker.current?.remove();
      driveMarker.current = null;
      if (drivePreview.mode === "idle") {
        const bounds = new maplibregl.LngLatBounds();
        for (const coordinate of selectedDrivingRoute?.coordinates ?? []) bounds.extend(coordinate);
        if (!bounds.isEmpty()) {
          const wide = instance.getContainer().clientWidth > 750;
          instance.fitBounds(bounds, {
            padding: { top: 85, bottom: 65, left: 45, right: wide ? 380 : 45 },
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
      element.className = "drive-car-marker";
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", "Simulated car on the selected route");
      element.innerHTML = '<svg viewBox="0 0 32 42" aria-hidden="true"><path d="M10 2h12l6 9v20l-6 9H10l-6-9V11z"/><path d="M9 15h14v12H9z"/><path d="M9 7h14M8 33h16"/></svg>';
      driveMarker.current = new maplibregl.Marker({
        element,
        anchor: "center",
        rotationAlignment: "map",
        pitchAlignment: "map",
      }).setLngLat([previewPosition.lng, previewPosition.lat]).addTo(instance);
    }
    driveMarker.current.setLngLat([previewPosition.lng, previewPosition.lat]);
    driveMarker.current.setRotation(previewPosition.bearing);
    instance.easeTo({
      center: [previewPosition.lng, previewPosition.lat],
      zoom: 16.5,
      pitch: 55,
      bearing: previewPosition.bearing,
      duration: 480,
    });
  }, [drivePreview.mode, previewPosition, selectedDrivingRoute]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (place) {
      const [west, south, east, north] = place.bounds;
      instance.fitBounds([[west, south], [east, north]], { ...PILOT_VIEW, duration: 0 });
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
      if (!point) continue;
      const marker = document.createElement("div");
      marker.className = `route-marker marker-${index}`;
      marker.textContent = index === 0 ? "A" : "B";
      marker.setAttribute("aria-label", `${index === 0 ? "Source" : "Destination"}: ${point.name}`);
      markers.push(new maplibregl.Marker({ element: marker }).setLngLat([point.lng, point.lat]).addTo(instance));
    }
    return () => markers.forEach((marker) => marker.remove());
  }, [drivePoints]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !drivingRoutes?.length) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const option of drivingRoutes) {
      for (const coordinate of option.coordinates) bounds.extend(coordinate);
    }
    if (!bounds.isEmpty()) {
      const wide = instance.getContainer().clientWidth > 750;
      instance.fitBounds(bounds, {
        padding: { top: 85, bottom: 65, left: 45, right: wide ? 380 : 45 },
        maxZoom: 15,
        duration: 0,
      });
    }
  }, [drivingRoutes]);

  useEffect(() => {
    const layers: Layer[] = [];
    if (heatHexes.length) {
      layers.push(new PolygonLayer<HexSummary>({
        id: "city-heat-hexes",
        data: heatHexes,
        getPolygon: (cell) => cell.rings,
        getFillColor: (cell) => temperatureColor(cell.value ?? 0),
        getLineColor: [255, 255, 255, 215],
        lineWidthMinPixels: 1,
        pickable: true,
      }));
    } else if (visibility.heat && cityHeat) {
      layers.push(new ScatterplotLayer<CityHeat["cells"][number]>({
        id: "city-heat",
        data: cityHeat.cells,
        getPosition: (cell) => [cell[0], cell[1]],
        getRadius: cityHeat.resolution_m * 0.57,
        radiusUnits: "meters",
        getFillColor: (cell) => temperatureColor(cell[2]),
        pickable: true,
      }));
    } else if (visibility.heat && heat?.status === "ready") {
      layers.push(new ScatterplotLayer<HeatCell>({
        id: "landsat-pixels",
        data: heat.cells,
        getPosition: (cell) => [cell.lng, cell.lat],
        getRadius: (heat.pixel_resolution_m ?? 30) * 0.57,
        radiusUnits: "meters",
        getFillColor: heatColor,
        pickable: true,
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
        { id: "recommended", path: route.route_geometry?.coordinates, color: [19, 112, 76] as const },
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
        getColor: (option) => option.id === selectedDrivingId ? [13, 111, 98, 255] : [87, 104, 140, 160],
        getWidth: (option) => option.id === selectedDrivingId ? 7 : 4,
        widthUnits: "pixels",
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getColor: selectedDrivingId, getWidth: selectedDrivingId },
      }));
    }
    overlay.current?.setProps({ layers });
  }, [cityFlood, cityHeat, heatHexes, floodHexes, heat, exposure, result, route, selectedRoute, visibility, drivingRoutes, selectedDrivingId]);

  return (
    <>
      <div className="map-frame">
        <div ref={container} className="map-canvas" aria-label="Interactive Bengaluru map" />
        {mapError && <p className="map-status" role="status">Basemap unavailable. Check your connection or browser graphics support.</p>}
        <button className="map-reset" type="button"
          onClick={() => { onReset(); map.current?.fitBounds(CITY_BOUNDS, CITY_VIEW); }}>
          View whole city
        </button>
      </div>
      <div className="map-legend" aria-label="Map legend">
        {hasCityOverlay && <strong className="map-detail" role="status">
          {hasHexes ? (detail === "city" ? "City hexagons · averages" : "District hexagons · averages") : "300 m cells"}
        </strong>}
        <span><i style={{ background: "#164f46" }} /> Municipal boundary</span>
        {(visibility.pilotFlood || visibility.combined) && <span><i className="pilot-line" /> Bellandur pilot boundary</span>}
        {visibility.floodDepth && cityFlood && <div className="flood-legend">
          <strong>Runoff on terrain depressions</strong>
          {FLOOD_LEGEND.map(({ label, color }) => (
            <span key={label}><i style={{ background: `rgb(${color.join(",")})` }} /> {label}</span>
          ))}
        </div>}
        {visibility.pilotFlood && <>
          <span><i style={{ background: "#507cb3" }} /> Depth &lt;15 cm</span>
          <span><i style={{ background: "#b16720" }} /> 15–30 cm</span>
          <span><i style={{ background: "#af2d30" }} /> &gt;30 cm</span>
        </>}
        {visibility.heat && <span><i className="heat-scale" /> Surface temperature · 25–45 °C</span>}
        {visibility.combined && <span><i style={{ background: "#814eb4" }} /> Depth ≥15 cm + heat top 10%</span>}
      </div>
    </>
  );
}
