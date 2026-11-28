import { useEffect, useState } from "react";
import { api, type WeatherAvailabilityResponse } from "../api/client";
import { assistantRefreshMs } from "./assistantOutlook";

export function useWeatherNowcast() {
  const [data, setData] = useState<WeatherAvailabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastReadyAt, setLastReadyAt] = useState<string | null>(null);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let current: AbortController | undefined;
    function poll() {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      void api.getWeatherNowcast(controller.signal).then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setError(null);
          if (result.status === "ready") setLastReadyAt(result.provenance.retrieved_at);
        }
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setData(null);
          setError(reason instanceof Error ? reason.message : "The outlook could not load.");
        }
      });
    }
    poll();
    const timer = window.setInterval(poll, assistantRefreshMs);
    return () => {
      current?.abort();
      window.clearInterval(timer);
    };
  }, [request]);

  return {
    data, error, lastReadyAt,
    refresh: () => {
      setData(null);
      setError(null);
      setRequest((value) => value + 1);
    },
  };
}
