import { useEffect, useRef, useState } from "react";
import { api, type DrivingResponse, type LatLng } from "../api/client";

export type Endpoint = "source" | "destination";
export type Waypoint = LatLng & { name: string };
export type Waypoints = Record<Endpoint, Waypoint | null>;
export type NavigationMode = "idle" | "locating" | "routing" | "active" | "rerouting" | "error";

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
  west: 77.44,
  south: 12.62,
  east: 77.80,
  north: 13.16,
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

function segmentBearing(a: [number, number], b: [number, number]): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const y = Math.sin(radians(b[0] - a[0])) * Math.cos(radians(b[1]));
  const x = Math.cos(radians(a[1])) * Math.sin(radians(b[1]))
    - Math.sin(radians(a[1])) * Math.cos(radians(b[1])) * Math.cos(radians(b[0] - a[0]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
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
        setNavigationNotice("Your GPS location is outside the supported Bengaluru navigation area.");
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

  function setPoint(endpoint: Endpoint, point: Waypoint | null) {
    stopNavigation();
    routeRequest.current?.abort();
    setPoints((previous) => {
      const next = { ...previous, [endpoint]: point };
      currentPoints.current = next;
      return next;
    });
    setResult(null);
    currentResult.current = null;
    setStatus(null);
    setLoading(false);
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

  return {
    points, setPoint, compare, result, selectedId, setSelectedId: selectRoute, loading, status,
    navigationMode, navigationLocation, navigationNotice, routeMatch, offRoute,
    startNavigation, stopNavigation, recalculateNavigation,
  };
}
