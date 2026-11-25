import { useEffect, useRef, useState } from "react";
import { api, type DrivingResponse, type LatLng } from "../api/client";

export type Endpoint = "source" | "destination";
export type Waypoint = LatLng & { name: string };
export type Waypoints = Record<Endpoint, Waypoint | null>;
const initialPoints: Waypoints = { source: null, destination: null };

export function useDrivingPlanner() {
  const [points, setPoints] = useState(initialPoints);
  const [result, setResult] = useState<DrivingResponse | null>(null);
  const [selectedId, setSelectedId] = useState("0");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  function setPoint(endpoint: Endpoint, point: Waypoint | null) {
    request.current?.abort();
    setPoints((previous) => ({ ...previous, [endpoint]: point }));
    setResult(null);
    setStatus(null);
    setLoading(false);
  }

  async function compare() {
    if (!points.source || !points.destination || loading) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setResult(null);
    setStatus(null);
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

  return { points, setPoint, compare, result, selectedId, setSelectedId, loading, status };
}
