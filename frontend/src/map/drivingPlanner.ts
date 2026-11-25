import { useEffect, useRef, useState } from "react";
import { api, type DrivingResponse, type LatLng } from "../api/client";

export type Endpoint = "source" | "destination";
export type Waypoint = LatLng & { name: string };
export type Waypoints = Record<Endpoint, Waypoint | null>;
export type DrivePreviewMode = "idle" | "running" | "paused" | "complete";
export interface RoutePosition { lng: number; lat: number; bearing: number }
const initialPoints: Waypoints = { source: null, destination: null };
const PREVIEW_DURATION_MS = 90_000;

function segmentDistance(a: [number, number], b: [number, number]): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLng = radians(b[0] - a[0]);
  const latA = radians(a[1]);
  const latB = radians(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function getRoutePosition(coordinates: [number, number][], progress: number): RoutePosition | null {
  if (coordinates.length < 2) return null;
  const segments = coordinates.slice(1).map((point, index) => segmentDistance(coordinates[index], point));
  const total = segments.reduce((sum, distance) => sum + distance, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  let remaining = Math.min(1, Math.max(0, progress)) * total;
  let segmentIndex = segments.length - 1;
  for (let index = 0; index < segments.length; index += 1) {
    if (remaining <= segments[index]) { segmentIndex = index; break; }
    remaining -= segments[index];
  }
  const start = coordinates[segmentIndex];
  const end = coordinates[segmentIndex + 1];
  const fraction = segments[segmentIndex] === 0 ? 0 : Math.min(1, remaining / segments[segmentIndex]);
  const lng = start[0] + (end[0] - start[0]) * fraction;
  const lat = start[1] + (end[1] - start[1]) * fraction;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const y = Math.sin(radians(end[0] - start[0])) * Math.cos(radians(end[1]));
  const x = Math.cos(radians(start[1])) * Math.sin(radians(end[1]))
    - Math.sin(radians(start[1])) * Math.cos(radians(end[1])) * Math.cos(radians(end[0] - start[0]));
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return { lng, lat, bearing };
}

export function useDrivingPlanner() {
  const [points, setPoints] = useState(initialPoints);
  const [result, setResult] = useState<DrivingResponse | null>(null);
  const [selectedId, setSelectedId] = useState("0");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewMode, setPreviewMode] = useState<DrivePreviewMode>("idle");
  const [previewProgress, setPreviewProgress] = useState(0);
  const previewProgressRef = useRef(0);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (previewMode !== "running") return undefined;
    const startedAt = performance.now() - previewProgressRef.current * PREVIEW_DURATION_MS;
    const timer = window.setInterval(() => {
      const nextProgress = Math.min(1, (performance.now() - startedAt) / PREVIEW_DURATION_MS);
      previewProgressRef.current = nextProgress;
      setPreviewProgress(nextProgress);
      if (nextProgress >= 1) setPreviewMode("complete");
    }, 500);
    return () => window.clearInterval(timer);
  }, [previewMode]);

  function endPreview() {
    setPreviewMode("idle");
    previewProgressRef.current = 0;
    setPreviewProgress(0);
  }

  function setPoint(endpoint: Endpoint, point: Waypoint | null) {
    request.current?.abort();
    setPoints((previous) => ({ ...previous, [endpoint]: point }));
    setResult(null);
    setStatus(null);
    setLoading(false);
    endPreview();
  }

  async function compare() {
    if (!points.source || !points.destination || loading) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setResult(null);
    setStatus(null);
    endPreview();
    try {
      const response = await api.driveRoutes(points.source, points.destination, controller.signal);
      if (controller.signal.aborted) return;
      setResult(response);
      setSelectedId(response.routes[0]?.id ?? "0");
    } catch (error) {
      if (!controller.signal.aborted) setStatus((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function selectRoute(id: string) {
    setSelectedId(id);
    endPreview();
  }

  function startPreview() {
    if (!result?.routes.some((option) => option.id === selectedId)) return;
    previewProgressRef.current = 0;
    setPreviewProgress(0);
    setPreviewMode("running");
  }

  function pausePreview() {
    setPreviewMode("paused");
  }

  function resumePreview() {
    if (previewProgress < 1) setPreviewMode("running");
  }

  return {
    points, setPoint, compare, result, selectedId, setSelectedId: selectRoute, loading, status,
    previewMode, previewProgress, startPreview, pausePreview, resumePreview, endPreview,
  };
}
