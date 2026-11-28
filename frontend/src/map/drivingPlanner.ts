import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DrivingOption, type DrivingResponse, type LatLng, type ScenarioRouteResponse, type TrafficFlowResponse, type TrafficLevel } from "../api/client";
import { useFloodStore, type AppliedRainfallScenario } from "../store/useFloodStore";

export type Endpoint = "source" | "destination";
export type Waypoint = LatLng & { name: string };
export type Waypoints = Record<Endpoint, Waypoint | null>;
export type NavigationMode = "idle" | "locating" | "routing" | "active" | "rerouting" | "simulating" | "arrived" | "error";

export interface LiveLocation extends LatLng {
  accuracy_m: number;
  heading_deg: number | null;
  speed_mps: number | null;
  timestamp: number;
}

export interface RouteMatch {
  lng: number;
  lat: number;
  bearing: number;
  distance_from_route_m: number;
  progress_m: number;
  remaining_m: number;
  progress: number;
}

export const NAVIGATION_AREA = {
  west: 68,
  south: 6,
  east: 98,
  north: 38,
} as const;

const initialPoints: Waypoints = { source: null, destination: null };
const MIN_REROUTE_INTERVAL_MS = 20_000;
const OFF_ROUTE_MIN_M = 90;

function segmentDistance(a: [number, number], b: [number, number]): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLng = radians(b[0] - a[0]);
  const latA = radians(a[1]);
  const latB = radians(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function routeVertexDistances(coordinates: [number, number][]): number[] {
  const distances = [0];
  for (let index = 1; index < coordinates.length; index++) {
    distances.push(distances[index - 1] + segmentDistance(coordinates[index - 1], coordinates[index]));
  }
  return distances;
}

function segmentBearing(a: [number, number], b: [number, number]): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const y = Math.sin(radians(b[0] - a[0])) * Math.cos(radians(b[1]));
  const x = Math.cos(radians(a[1])) * Math.sin(radians(b[1]))
    - Math.sin(radians(a[1])) * Math.cos(radians(b[1])) * Math.cos(radians(b[0] - a[0]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function positionAtDistance(coordinates: DrivingOption["coordinates"], distances: number[], metres: number) {
  let left = 1;
  let right = distances.length - 1;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (distances[middle] >= metres) right = middle;
    else left = middle + 1;
  }
  const a = coordinates[left - 1];
  const b = coordinates[left];
  const length = distances[left] - distances[left - 1];
  const fraction = length ? (metres - distances[left - 1]) / length : 0;
  return { point: [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction] as [number, number], edgeEnd: left };
}

export function pathForFraction(coordinates: DrivingOption["coordinates"], distances: number[], start: number, end: number) {
  const total = distances[distances.length - 1];
  const first = positionAtDistance(coordinates, distances, total * start);
  const last = positionAtDistance(coordinates, distances, total * end);
  return [first.point, ...coordinates.slice(first.edgeEnd, last.edgeEnd), last.point];
}

function mergeTraffic(route: DrivingOption, flow: Extract<TrafficFlowResponse, { status: "ready" }>) {
  const levels = Array<TrafficLevel>(route.coordinates.length - 1).fill("unknown");
  for (const span of flow.segments) levels.fill(span.level, span.start_index, span.end_index);
  for (const span of route.traffic_segments ?? []) {
    if (span.level !== "unknown") levels.fill(span.level, span.start_index, span.end_index);
  }
  const spans: NonNullable<DrivingOption["traffic_segments"]> = [];
  for (let start = 0, end = 1; end <= levels.length; end++) {
    if (levels[end] === levels[start]) continue;
    spans.push({ start_index: start, end_index: end, level: levels[start] });
    start = end;
  }
  return spans;
}

export function isWithinNavigationArea(point: LatLng): boolean {
  return point.lat >= NAVIGATION_AREA.south && point.lat <= NAVIGATION_AREA.north
    && point.lng >= NAVIGATION_AREA.west && point.lng <= NAVIGATION_AREA.east;
}

/** Match one real GPS fix to the nearest point on a route's GeoJSON coordinates. */
export function matchRoutePosition(coordinates: [number, number][], point: LatLng): RouteMatch | null {
  if (coordinates.length < 2) return null;
  const segments = coordinates.slice(1).map((end, index) => ({
    start: coordinates[index],
    end,
    length: segmentDistance(coordinates[index], end),
  }));
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  let distanceBefore = 0;
  let closest: RouteMatch | null = null;
  for (const segment of segments) {
    const meanLatitude = (segment.start[1] + segment.end[1] + point.lat) / 3;
    const metresPerDegreeLng = 111_320 * Math.cos(meanLatitude * Math.PI / 180);
    const metresPerDegreeLat = 110_574;
    const dx = (segment.end[0] - segment.start[0]) * metresPerDegreeLng;
    const dy = (segment.end[1] - segment.start[1]) * metresPerDegreeLat;
    const px = (point.lng - segment.start[0]) * metresPerDegreeLng;
    const py = (point.lat - segment.start[1]) * metresPerDegreeLat;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
    const lng = segment.start[0] + (segment.end[0] - segment.start[0]) * fraction;
    const lat = segment.start[1] + (segment.end[1] - segment.start[1]) * fraction;
    const distanceFromRoute = Math.hypot(
      (point.lng - lng) * metresPerDegreeLng,
      (point.lat - lat) * metresPerDegreeLat,
    );
    const progressM = distanceBefore + segment.length * fraction;
    if (!closest || distanceFromRoute < closest.distance_from_route_m) {
      closest = {
        lng,
        lat,
        bearing: segmentBearing(segment.start, segment.end),
        distance_from_route_m: distanceFromRoute,
        progress_m: progressM,
        remaining_m: Math.max(0, total - progressM),
        progress: progressM / total,
      };
    }
    distanceBefore += segment.length;
  }
  return closest;
}

function locationFromPosition(position: GeolocationPosition): LiveLocation {
  const { latitude: lat, longitude: lng, accuracy, heading, speed } = position.coords;
  return {
    lat,
    lng,
    accuracy_m: accuracy,
    heading_deg: heading !== null && Number.isFinite(heading) ? heading : null,
    speed_mps: speed !== null && Number.isFinite(speed) ? speed : null,
    timestamp: position.timestamp,
  };
}

export function useDrivingPlanner() {
  const scenario = useFloodStore((state) => state.appliedRainfall);
  const [points, setPoints] = useState(initialPoints);
  const [result, setResult] = useState<DrivingResponse | null>(null);
  const [selectedId, setSelectedId] = useState("0");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [navigationMode, setNavigationModeState] = useState<NavigationMode>("idle");
  const [navigationLocation, setNavigationLocation] = useState<LiveLocation | null>(null);
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null);
  const [routeMatch, setRouteMatch] = useState<RouteMatch | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [watchingLocation, setWatchingLocation] = useState(false);
  const [scenarioScreen, setScenarioScreen] = useState<{
    scenario: AppliedRainfallScenario; result: DrivingResponse; value: ScenarioRouteResponse;
  } | null>(null);
  const [trafficFlow, setTrafficFlow] = useState<{
    route: DrivingOption; value: Extract<TrafficFlowResponse, { status: "ready" }>;
  } | null>(null);
  const navigationModeRef = useRef<NavigationMode>("idle");
  const navigationRequest = useRef<AbortController | null>(null);
  const routeRequest = useRef<AbortController | null>(null);
  const currentPoints = useRef(points);
  const currentResult = useRef(result);
  const currentSelectedId = useRef(selectedId);
  const currentLocation = useRef<LiveLocation | null>(null);
  const routeStartLocation = useRef<LiveLocation | null>(null);
  const watchId = useRef<number | null>(null);
  const handleLocationRef = useRef<(position: GeolocationPosition) => void>(() => undefined);
  const offRouteCount = useRef(0);
  const lastRerouteAt = useRef(0);

  currentPoints.current = points;
  currentResult.current = result;
  currentSelectedId.current = selectedId;
  const selected = result?.routes.find((route) => route.id === selectedId);
  const simulationRoute = navigationMode === "simulating" ? selected : undefined;
  const sampleLiveTraffic = result?.source === "TomTom Routing";
  const activeFlow = trafficFlow?.route === selected ? trafficFlow?.value : undefined;
  const liveTrafficSegments = useMemo(() => selected && activeFlow ? mergeTraffic(selected, activeFlow) : undefined, [selected, activeFlow]);
  const scenarioValue = scenarioScreen?.scenario === scenario && scenarioScreen?.result === result ? scenarioScreen.value : null;
  const scenarioRoutes = useMemo(() => scenarioValue?.status === "ready" && result ? result.routes.map((route, index) => {
    const exposure = scenarioValue.routes[index];
    const providerSecondsPerKm = route.eta_seconds / exposure.route_km;
    // Deliberately hypothetical speeds for a presentation. Keep the current route estimate intact.
    const delay = (exposure.exposed_km - exposure.high_km) * Math.max(0, 240 - providerSecondsPerKm)
      + exposure.high_km * Math.max(0, 720 - providerSecondsPerKm);
    return { ...exposure, id: route.id, demoEtaSeconds: route.eta_seconds + Math.max(0, delay) };
  }) : [], [result, scenarioValue]);
  const comparable = scenarioRoutes.length > 1 && scenarioRoutes.every((route) => route.covered_km >= route.route_km * .95);
  const bestScenarioRoute = comparable ? [...scenarioRoutes].sort((a, b) => a.exposed_km - b.exposed_km || a.demoEtaSeconds - b.demoEtaSeconds)[0] : null;
  const recommendedScenarioId = bestScenarioRoute && scenarioRoutes.some((route) => route.exposed_km - bestScenarioRoute.exposed_km >= .1)
    ? bestScenarioRoute.id : null;

  useEffect(() => {
    if (!result?.routes.length || !scenario) return;
    const controller = new AbortController();
    const roads = result.routes.map((route) => route.coordinates);
    void api.screenDrivingScenario(scenario.rainfallMm, roads, controller.signal).then((value) => {
      if (value.status === "ready" && value.routes.length !== roads.length) throw new Error("Unexpected route screening response.");
      if (!controller.signal.aborted) setScenarioScreen({ scenario, result, value });
    }).catch(() => {
      if (!controller.signal.aborted) setScenarioScreen({ scenario, result, value: { status: "unavailable", message: "Rainfall scenario route screening is unavailable." } });
    });
    return () => controller.abort();
  }, [result, scenario]);

  useEffect(() => {
    if (!sampleLiveTraffic || !selected || (selected.traffic_segments?.length && selected.traffic_segments.every((span) => span.level !== "unknown"))) return;
    let pending: AbortController | undefined;
    function refresh() {
      if (!selected) return;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      void api.sampleTraffic(selected.coordinates, controller.signal).then((value) => {
        if (!controller.signal.aborted) setTrafficFlow(value.status === "ready" ? { route: selected, value } : null);
      }).catch(() => {
        if (!controller.signal.aborted) setTrafficFlow(null);
      });
    }
    refresh();
    const timer = window.setInterval(refresh, 5 * 60_000);
    return () => {
      window.clearInterval(timer);
      pending?.abort();
    };
  }, [sampleLiveTraffic, selected]);

  useEffect(() => {
    if (!simulationRoute) return;
    const { coordinates, distance_km, eta_seconds } = simulationRoute;
    const distances = routeVertexDistances(coordinates);
    const total = distances[distances.length - 1];
    const started = performance.now();
    function step() {
      const progress = Math.min(1, (performance.now() - started) / 35_000);
      const travelled = total * progress;
      const { point: [lng, lat] } = positionAtDistance(coordinates, distances, travelled);
      const { point: ahead } = positionAtDistance(coordinates, distances, Math.min(total, travelled + 25));
      const bearing = progress < 1 ? segmentBearing([lng, lat], ahead) : null;
      setRouteMatch({ lng, lat, bearing: bearing ?? 0, distance_from_route_m: 0, progress_m: travelled, remaining_m: total - travelled, progress });
      setNavigationLocation({ lng, lat, accuracy_m: 0, heading_deg: bearing, speed_mps: progress < 1 ? distance_km * 1000 / eta_seconds : 0, timestamp: Date.now() });
      if (progress >= 1) {
        setNavigationMode("arrived");
        setNavigationNotice("Demo car reached the destination.");
      }
    }
    step();
    const timer = window.setInterval(step, 200);
    return () => window.clearInterval(timer);
  }, [simulationRoute]);

  function setNavigationMode(mode: NavigationMode) {
    navigationModeRef.current = mode;
    setNavigationModeState(mode);
  }

  function stopNavigation() {
    navigationRequest.current?.abort();
    navigationRequest.current = null;
    routeRequest.current?.abort();
    routeRequest.current = null;
    setWatchingLocation(false);
    setNavigationMode("idle");
    setNavigationLocation(null);
    currentLocation.current = null;
    routeStartLocation.current = null;
    setNavigationNotice(null);
    setRouteMatch(null);
    setOffRoute(false);
    offRouteCount.current = 0;
    lastRerouteAt.current = 0;
  }

  function startCarSimulation() {
    if (!selected || selected.coordinates.length < 2) return;
    const distances = routeVertexDistances(selected.coordinates);
    if (distances[distances.length - 1] === 0) return;
    stopNavigation();
    setNavigationNotice("Simulated drive · finishes in about 35 seconds.");
    setNavigationMode("simulating");
    return true;
  }

  async function routeFromLocation(location: LiveLocation, reroute: boolean) {
    const destination = currentPoints.current.destination;
    if (!destination) {
      setNavigationNotice("Choose a destination before starting navigation.");
      setNavigationMode("error");
      setWatchingLocation(false);
      return;
    }
    navigationRequest.current?.abort();
    const controller = new AbortController();
    navigationRequest.current = controller;
    if (reroute) lastRerouteAt.current = Date.now();
    setNavigationMode(reroute ? "rerouting" : "routing");
    setNavigationNotice(reroute ? "Finding a new route from your current location…" : null);
    try {
      const response = await api.driveRoutes(location, destination, controller.signal);
      if (controller.signal.aborted) return;
      const firstRoute = response.routes[0];
      if (!firstRoute) throw new Error("No drivable route was returned for your current location.");
      setResult(response);
      currentResult.current = response;
      setSelectedId(firstRoute.id);
      currentSelectedId.current = firstRoute.id;
      setRouteMatch(matchRoutePosition(firstRoute.coordinates, location));
      routeStartLocation.current = location;
      setOffRoute(false);
      offRouteCount.current = 0;
      setNavigationMode("active");
      setNavigationNotice(reroute ? "Route updated from your current GPS location." : null);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Could not find a route from your location.";
      if (reroute && navigationModeRef.current === "rerouting") {
        setNavigationMode("active");
        setNavigationNotice(`Couldn't recalculate. Keeping the previous route. ${message}`);
      } else {
        setNavigationMode("error");
        setNavigationNotice(message);
        setWatchingLocation(false);
      }
    } finally {
      if (navigationRequest.current === controller) navigationRequest.current = null;
    }
  }

  function handleLocation(position: GeolocationPosition) {
    const location = locationFromPosition(position);
    if (!isWithinNavigationArea(location)) {
      if (navigationModeRef.current === "locating") {
        setNavigationNotice("Your GPS location is outside the supported India map area.");
        setNavigationMode("error");
        setWatchingLocation(false);
      } else {
        setNavigationNotice("GPS location is outside the supported navigation area.");
      }
      return;
    }
    if (!Number.isFinite(location.accuracy_m) || location.accuracy_m > 100) {
      setNavigationNotice(`Waiting for a better GPS fix (current accuracy ±${Math.round(location.accuracy_m)} m).`);
      return;
    }

    currentLocation.current = location;
    setNavigationLocation(location);
    setNavigationNotice((notice) => notice?.startsWith("GPS is taking too long")
      || notice?.startsWith("GPS location is temporarily unavailable")
      || notice?.startsWith("Waiting for a better GPS fix") ? null : notice);
    if (navigationModeRef.current === "locating") {
      void routeFromLocation(location, false);
      return;
    }
    if (navigationModeRef.current !== "active") return;

    const route = currentResult.current?.routes.find((item) => item.id === currentSelectedId.current);
    if (!route) return;
    const match = matchRoutePosition(route.coordinates, location);
    setRouteMatch(match);
    if (!match) {
      setOffRoute(false);
      return;
    }

    const offRouteThreshold = Math.max(OFF_ROUTE_MIN_M, location.accuracy_m * 1.5);
    const start = routeStartLocation.current;
    const movedFromStart = Boolean(start && segmentDistance([start.lng, start.lat], [location.lng, location.lat]) >= 75);
    const isOffRoute = movedFromStart && match.distance_from_route_m > offRouteThreshold;
    setOffRoute(isOffRoute);
    offRouteCount.current = isOffRoute ? offRouteCount.current + 1 : 0;
    const cooldownPassed = Date.now() - lastRerouteAt.current >= MIN_REROUTE_INTERVAL_MS;
    if (offRouteCount.current >= 3 && cooldownPassed) void routeFromLocation(location, true);
  }

  handleLocationRef.current = handleLocation;

  useEffect(() => {
    if (!watchingLocation) return undefined;
    if (!navigator.geolocation) {
      setNavigationNotice("This browser does not support GPS location.");
      setNavigationMode("error");
      setWatchingLocation(false);
      return undefined;
    }
    watchId.current = navigator.geolocation.watchPosition((position) => handleLocationRef.current(position), (error) => {
      if (error.code === error.PERMISSION_DENIED) {
        setNavigationNotice("Location access was denied. Allow it in browser settings and try again.");
        setNavigationMode("error");
        setWatchingLocation(false);
      } else {
        setNavigationNotice(error.code === error.TIMEOUT
          ? "GPS is taking too long. Move to an open area and retry."
          : "GPS location is temporarily unavailable. Waiting for another fix.");
      }
    }, { enableHighAccuracy: true, maximumAge: 2_000, timeout: 20_000 });
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [watchingLocation]);

  useEffect(() => () => {
    navigationRequest.current?.abort();
    routeRequest.current?.abort();
    if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current);
  }, []);

  function setTrip(next: Waypoints) {
    stopNavigation();
    currentPoints.current = next;
    setPoints(next);
    setResult(null);
    currentResult.current = null;
    setStatus(null);
    setLoading(false);
  }

  function setPoint(endpoint: Endpoint, point: Waypoint | null) {
    setTrip({ ...currentPoints.current, [endpoint]: point });
  }

  async function compare() {
    const { source, destination } = currentPoints.current;
    if (!source || !destination || loading) return;
    stopNavigation();
    const controller = new AbortController();
    routeRequest.current = controller;
    setLoading(true);
    setResult(null);
    currentResult.current = null;
    setStatus(null);
    try {
      const response = await api.driveRoutes(source, destination, controller.signal);
      if (controller.signal.aborted) return;
      setResult(response);
      currentResult.current = response;
      const firstRoute = response.routes[0];
      setSelectedId(firstRoute?.id ?? "0");
      currentSelectedId.current = firstRoute?.id ?? "0";
      return response;
    } catch (error) {
      if (!controller.signal.aborted) setStatus((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function selectRoute(id: string) {
    if (navigationModeRef.current !== "idle") return;
    setSelectedId(id);
    currentSelectedId.current = id;
  }

  function startNavigation() {
    if (!currentPoints.current.destination) {
      setNavigationNotice("Choose a destination before starting navigation.");
      setNavigationMode("error");
      return;
    }
    if (!navigator.geolocation) {
      setNavigationNotice("This browser does not support GPS location.");
      setNavigationMode("error");
      return;
    }
    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setNavigationNotice("GPS navigation requires HTTPS or localhost.");
      setNavigationMode("error");
      return;
    }
    navigationRequest.current?.abort();
    setNavigationLocation(null);
    currentLocation.current = null;
    setRouteMatch(null);
    setOffRoute(false);
    setNavigationNotice("Waiting for a GPS fix…");
    setNavigationMode("locating");
    setWatchingLocation(true);
  }

  function recalculateNavigation() {
    if (currentLocation.current) void routeFromLocation(currentLocation.current, true);
    else setNavigationNotice("Waiting for GPS before recalculating the route.");
  }

  function navigateTo(destination: Waypoint) {
    setTrip({ source: null, destination });
    startNavigation();
  }

  return {
    points, setPoint, compare, result, selectedId, setSelectedId: selectRoute, loading, status,
    scenario, scenarioValue, scenarioRoutes, recommendedScenarioId,
    liveTrafficSegments, trafficFlowCheckedAt: activeFlow?.checked_at,
    navigationMode, navigationLocation, navigationNotice, routeMatch, offRoute,
    startNavigation, navigateTo, startCarSimulation, stopNavigation, recalculateNavigation,
  };
}
