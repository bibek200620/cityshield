import { useEffect, useState } from "react";
import { api, type LatLng, type WeatherAvailabilityResponse } from "../api/client";
import { assistantRefreshMs } from "./assistantOutlook";

export function useWeatherNowcast(location: LatLng) {
  const { lat, lng } = location;
  const [result, setResult] = useState<{
    locationKey: string;
    data: WeatherAvailabilityResponse | null;
    error: string | null;
    lastReadyAt: string | null;
  } | null>(null);
  const locationKey = `${lat},${lng}`;
  const currentResult = result?.locationKey === locationKey ? result : null;
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let current: AbortController | undefined;
    function poll() {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      void api.getWeatherNowcast(controller.signal, { lat, lng }).then((result) => {
        if (!controller.signal.aborted) {
          setResult((previous) => ({ locationKey, data: result, error: null,
            lastReadyAt: result.status === "ready" ? result.provenance.retrieved_at
              : previous?.locationKey === locationKey ? previous.lastReadyAt : null }));
        }
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setResult((previous) => ({ locationKey, data: null,
            error: reason instanceof Error ? reason.message : "The outlook could not load.",
            lastReadyAt: previous?.locationKey === locationKey ? previous.lastReadyAt : null }));
        }
      });
    }
    poll();
    const timer = window.setInterval(poll, assistantRefreshMs);
    return () => {
      current?.abort();
      window.clearInterval(timer);
    };
  }, [lat, lng, locationKey, request]);

  return {
    data: currentResult?.data ?? null, error: currentResult?.error ?? null, lastReadyAt: currentResult?.lastReadyAt ?? null,
    refresh: () => {
      setResult((previous) => previous ? { ...previous, data: null, error: null } : null);
      setRequest((value) => value + 1);
    },
  };
}
