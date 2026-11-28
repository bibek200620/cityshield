import { useMemo, useState, type FormEvent } from "react";
import type { CityFloodResponse } from "../api/client";
import { downloadCsv } from "../downloadCsv";
import { scenarioRainfall, useScenarioBaseline } from "../map/scenarioBaseline";
import { countHighRunoffCells, summarizeWardRunoff } from "../map/wardEvidence";
import { floodDemoPreset, useFloodStore } from "../store/useFloodStore";
import type { CityHeat } from "./MapView";
import type { BengaluruPlace } from "../map/places";
import type { WardSummary } from "./WardInspector";

const savedTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

interface Metric {
  label: string;
  unit: string;
  digits: number;
  baseline: number | null;
  active: number | null;
  deltaUnit?: string;
  adverseIncrease?: boolean;
}

function metricValue(value: number | null, digits: number, unit: string) {
  if (value === null) return "—";
  const suffix = unit && unit !== "%" ? ` ${unit}` : unit;
  return `${value.toFixed(digits)}${suffix}`;
}

function metricDelta(metric: Metric): number | null {
  if (metric.baseline === null || metric.active === null) return null;
  return Number((metric.active - metric.baseline).toFixed(metric.digits));
}

export default function ScenarioComparison({ currentFlood, place, ward, heat, onEdit, retryActive, wardFailed, retryWard }: {
  currentFlood: CityFloodResponse | null;
  place: BengaluruPlace | null;
  ward: WardSummary | null;
  heat: CityHeat | null;
  onEdit: () => void;
  retryActive: () => void;
  wardFailed: boolean;
  retryWard: () => void;
}) {
  const rainfall = useFloodStore((s) => s.currentRainfall);
  const active = useFloodStore((s) => s.simulationActive);
  const airOffset = useFloodStore((s) => s.heatOffsetC);
  const heatOffset = useFloodStore((s) => s.surfaceOffsetC);
  const presets = useFloodStore((s) => s.scenarios);
  const selectedPreset = useFloodStore((s) => s.selectedPresetId);
  const [baselinePreset, setBaselinePreset] = useState("");
  const currentInputs = { ...rainfall, heatOffset, airOffset };
  const currentTotal = active ? scenarioRainfall(currentInputs) : null;
  const activeScreen = active ? currentFlood : null;
  const { baseline, save, storageError, flood, retry } = useScenarioBaseline(currentTotal, activeScreen);
  const baselineWard = useMemo(() => ward && flood?.status === "ready" ?
    summarizeWardRunoff(ward.evidence, flood) : null, [ward, flood]);
  const activeLabel = selectedPreset === floodDemoPreset.id ? "Flood demo" :
    presets.find((preset) => preset.scenario_id === selectedPreset)?.label ?? "Custom rainfall";
  const sceneTemperature = ward?.heat?.mean;
  const baselineShare = baselineWard?.highAreaPercent;
  const activeShare = ward?.runoff?.highAreaPercent;

  function saveBaseline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const preset = presets.find((item) => item.scenario_id === baselinePreset);
    if (!preset && (!active || baselinePreset)) return;
    save({
      ...(preset ? { intensity: preset.rainfall_intensity_mm_hr, duration: preset.duration_min, heatOffset: 0 } : currentInputs),
      label: preset?.label ?? activeLabel,
      savedAt: new Date().toISOString(),
    });
  }

  const metrics: Metric[] = [
    { label: "Rainfall input", unit: "mm", digits: 1, baseline: baseline ? scenarioRainfall(baseline) : null, active: currentTotal },
    { label: "Intensity", unit: "mm/h", digits: 1, baseline: baseline?.intensity ?? null, active: active ? rainfall.intensity : null },
    { label: "Duration", unit: "min", digits: 1, baseline: baseline?.duration ?? null, active: active ? rainfall.duration : null },
  ];

  if (place) {
    metrics.push(
      { label: "Mean runoff", unit: "mm", digits: 1, baseline: baselineWard?.mean ?? null, active: ward?.runoff?.mean ?? null, adverseIncrease: true },
      { label: "Scored area above 20 mm", unit: "%", digits: 1, baseline: baselineShare ?? null,
        active: activeShare ?? null, deltaUnit: "pp", adverseIncrease: true },
      { label: "Mean surface temperature", unit: "°C", digits: 1, baseline: baseline && sceneTemperature != null ? sceneTemperature + baseline.heatOffset : null,
        active: active && sceneTemperature != null ? sceneTemperature + heatOffset : null },
    );
  } else {
    metrics.push({
      label: "Grid cells above 20 mm", unit: "cells", digits: 0, adverseIncrease: true,
      baseline: flood?.status === "ready" ? countHighRunoffCells(flood) : null,
      active: activeScreen?.status === "ready" ? countHighRunoffCells(activeScreen) : null,
    });
  }
  metrics.push(
    { label: "Landsat surface-temperature offset", unit: "°C", digits: 1, baseline: baseline?.heatOffset ?? null, active: active ? heatOffset : null },
    { label: "Air-temperature offset", unit: "°C", digits: 1, baseline: baseline ? baseline.airOffset ?? 0 : null, active: active ? airOffset : null },
  );

  function exportComparison() {
    if (!baseline || activeScreen?.status !== "ready" || flood?.status !== "ready") return;
    downloadCsv(`cityshield-scenarios-${place ? place.id.replace(":", "-") : "bengaluru"}.csv`, [
      ["scope", "ward_id", "baseline", "active_scenario", "baseline_saved_at_utc", "runoff_source", "runoff_method", "runoff_grid_m",
        "landsat_scene_date", "metric", "unit", "baseline_value", "active_value", "change", "change_unit"],
      ...metrics.map((metric) => [
        place ? `${place.name}, ${place.corporation}` : "Greater Bengaluru", place?.id ?? "",
        baseline.label, activeLabel, baseline.savedAt, activeScreen.source, activeScreen.model, activeScreen.grid_m,
        place ? heat?.date ?? "" : "", metric.label, metric.unit,
        metric.baseline === null ? null : Number(metric.baseline.toFixed(metric.digits)),
        metric.active === null ? null : Number(metric.active.toFixed(metric.digits)),
        metricDelta(metric), metric.deltaUnit ?? metric.unit,
      ]),
    ]);
  }

  return <section className="comparison-workspace" aria-label="Scenario evidence">
    <p className="comparison-scope"><strong>{place?.name ?? "Greater Bengaluru"}</strong>
      <span>{place ? `${place.corporation} corporation` : "2025 GBA boundary"}</span></p>
    <form className="baseline-controls" onSubmit={saveBaseline}>
      <label>Baseline input
        <select value={baselinePreset} onChange={(event) => setBaselinePreset(event.target.value)}>
          <option value="">Current scenario</option>
          {presets.map((preset) => <option key={preset.scenario_id} value={preset.scenario_id}>{preset.label}</option>)}
        </select>
      </label>
      <button type="submit" className="secondary-button" disabled={!active && !baselinePreset}>{baseline ? "Replace baseline" : "Save baseline"}</button>
    </form>
    {storageError && <p className="scenario-result" role="status">The browser could not save this baseline for the next visit.</p>}
    {!baseline && <p className="scenario-result">Save the current inputs or a preset to compare with the active scenario.</p>}
    {baseline && <>
      <div className="comparison-pair">
        <div><span>Baseline</span><strong>{baseline.label}</strong>
          <time dateTime={baseline.savedAt}>{savedTime.format(new Date(baseline.savedAt))} IST</time>
        </div>
        <div><span>Active scenario</span><strong>{active ? activeLabel : "Simulation stopped"}</strong>
          <button type="button" className="pick-button" onClick={onEdit}>Edit rainfall inputs</button>
        </div>
      </div>
      {place && baselineShare != null && activeShare != null && <div className="comparison-bars" aria-hidden="true">
        <span>Scored area above 20 mm</span>
        <div><span style={{ width: `${Math.min(100, baselineShare)}%` }} /></div>
        <div><span style={{ width: `${Math.min(100, activeShare)}%` }} /></div>
      </div>}
      <table className="comparison-table" aria-label="Baseline and active scenario comparison">
        <thead><tr><th scope="col">Metric</th><th scope="col">Baseline</th><th scope="col">Active</th><th scope="col">Change</th></tr></thead>
        <tbody>{metrics.map((metric) => {
          const delta = metricDelta(metric);
          return <tr key={metric.label}>
            <th scope="row">{metric.label}</th>
            <td>{metricValue(metric.baseline, metric.digits, metric.unit)}</td>
            <td>{metricValue(metric.active, metric.digits, metric.unit)}</td>
            <td data-increase={metric.adverseIncrease && delta !== null && delta > 0}>
              {delta !== null && delta > 0 ? "+" : ""}{metricValue(delta, metric.digits, metric.deltaUnit ?? metric.unit)}
            </td>
          </tr>;
        })}</tbody>
      </table>
      {(!flood || (active && !activeScreen) || (place && !ward && !wardFailed)) &&
        <p className="scenario-result" role="status">Waiting for runoff or ward data…</p>}
      {place && wardFailed && <p className="scenario-result" role="status">Ward overlap data is unavailable. <button className="pick-button" type="button" onClick={retryWard}>Retry ward</button></p>}
      {flood?.status === "unavailable" &&
        <p className="scenario-result" role="status">{flood.message} <button className="pick-button" type="button" onClick={flood === activeScreen ? retryActive : retry}>Retry baseline</button></p>}
      {activeScreen?.status === "unavailable" && activeScreen !== flood &&
        <p className="scenario-result" role="status">{activeScreen.message} <button className="pick-button" type="button" onClick={retryActive}>Retry active screen</button></p>}
      <div className="comparison-actions">
        <button type="button" className="secondary-button" onClick={exportComparison}
          disabled={activeScreen?.status !== "ready" || flood?.status !== "ready" || Boolean(place && !ward)}>Export comparison CSV</button>
        <button type="button" className="pick-button" onClick={() => save(null)}>Clear baseline</button>
      </div>
    </>}
    <p className="scenario-result">Runoff uses total scenario rainfall. {place ?
      "Ward statistics weight 300 m grid values by area. The 20 mm threshold applies to screened runoff. Satellite surface-temperature values use historical imagery and the chosen offset." :
      "The count uses distinct municipal grid cells. Use ward search for area-weighted ward comparisons."}</p>
  </section>;
}
