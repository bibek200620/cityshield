import { useEffect, useState } from "react";
import { api, type CityFloodResponse } from "../api/client";

export interface ScenarioInputs {
  intensity: number;
  duration: number;
  heatOffset: number;
  airOffset?: number;
}

export interface ScenarioBaseline extends ScenarioInputs {
  label: string;
  savedAt: string;
}

const storageKey = "cityshield.scenario-baseline.v1";

export function scenarioRainfall({ intensity, duration }: ScenarioInputs): number {
  return intensity * duration / 60;
}

function readBaseline(): ScenarioBaseline | null {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return null;
    const value = JSON.parse(stored) as ScenarioBaseline;
    if (value && Number.isFinite(value.intensity) && value.intensity >= 5 && value.intensity <= 150 &&
      Number.isFinite(value.duration) && value.duration >= 15 && value.duration <= 180 &&
      Number.isFinite(value.heatOffset) && Math.abs(value.heatOffset) <= 20 &&
      (value.airOffset === undefined || Number.isFinite(value.airOffset) && Math.abs(value.airOffset) <= 20) &&
      typeof value.label === "string" && value.label.length <= 120 &&
      typeof value.savedAt === "string" && Number.isFinite(Date.parse(value.savedAt))) return value;
  } catch {
    return null;
  }
  return null;
}

export function useScenarioBaseline(activeRainfall: number | null, currentFlood: CityFloodResponse | null) {
  const [baseline, setBaseline] = useState(readBaseline);
  const [storageError, setStorageError] = useState(false);
  const [cached, setCached] = useState<{ rainfall: number; result: CityFloodResponse } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const rainfall = baseline ? scenarioRainfall(baseline) : null;
  const sameStorm = rainfall === activeRainfall;
  const matching = cached?.rainfall === rainfall ? cached.result : null;
  // A successful screen depends only on total rainfall. Reuse it across scope changes.
  const cachedReady = matching?.status === "ready";

  useEffect(() => {
    if (rainfall === null || sameStorm || cachedReady) return;
    const controller = new AbortController();
    void api.getCityFlood(rainfall, controller.signal).then((result) => {
      if (!controller.signal.aborted) setCached({ rainfall, result });
    }).catch(() => {
      if (!controller.signal.aborted) setCached({
        rainfall, result: { status: "unavailable", message: "The baseline runoff screen could not load." },
      });
    });
    return () => controller.abort();
  }, [attempt, cachedReady, rainfall, sameStorm]);

  function save(next: ScenarioBaseline | null) {
    setBaseline(next);
    setStorageError(false);
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
    } catch {
      setStorageError(true);
    }
  }

  return {
    baseline, storageError, save,
    flood: sameStorm ? currentFlood : matching,
    retry: () => {
      setCached(null);
      setAttempt((value) => value + 1);
    },
  };
}
