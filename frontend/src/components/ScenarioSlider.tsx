import { useState, type FormEvent } from "react";
import { floodDemoPreset, rainfallLimits, useFloodStore } from "../store/useFloodStore";
import IndiaCitySelect from "./IndiaCitySelect";
import type { MapPlace } from "./PlaceSearch";

export default function ScenarioSlider({ selectedPlace, onSelectPlace }: {
  selectedPlace: MapPlace | null;
  onSelectPlace: (place: MapPlace) => void;
}) {
  const scenarios = useFloodStore((s) => s.scenarios);
  const current = useFloodStore((s) => s.currentRainfall);
  const result = useFloodStore((s) => s.simulateResult);
  const runScenario = useFloodStore((s) => s.runScenario);
  const runCustomRainfall = useFloodStore((s) => s.runCustomRainfall);
  const loading = useFloodStore((s) => s.loading);
  const active = useFloodStore((s) => s.simulationActive);
  const applied = useFloodStore((s) => s.appliedRainfall);
  const stopSimulation = useFloodStore((s) => s.stopSimulation);
  const heatOffset = useFloodStore((s) => s.heatOffsetC);
  const surfaceOffset = useFloodStore((s) => s.surfaceOffsetC);
  const showRoads = useFloodStore((s) => s.layerVisibility.cityRoads);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const [draft, setDraft] = useState<{ intensity: string; duration: string; preset: string; temperature: string } | null>(null);
  const selectedPresetId = useFloodStore((s) => s.selectedPresetId);
  const supportsSimulation = Boolean(selectedPlace && /bengaluru|bangalore/i.test(selectedPlace.name)
    && selectedPlace.center[0] >= 77.39 && selectedPlace.center[0] <= 77.85
    && selectedPlace.center[1] >= 12.57 && selectedPlace.center[1] <= 13.21);
  const values = draft ?? { intensity: String(current.intensity), duration: String(current.duration), preset: selectedPresetId ?? "", temperature: String(heatOffset) };
  const flooded = result?.road_segments.filter((segment) => segment.state === "flooded").length;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const offsets = { air: Number(values.temperature), surface: surfaceOffset };
    if (values.preset === floodDemoPreset.id) {
      void runCustomRainfall(floodDemoPreset.intensity, floodDemoPreset.duration, offsets, true);
    } else if (values.preset) {
      void runScenario(values.preset, offsets);
    } else {
      void runCustomRainfall(Number(values.intensity), Number(values.duration), offsets);
    }
  }

  return (
    <section aria-label="Rainfall inputs">
      <p className="scenario-result">Choose an area before simulating. Terrain and drainage inputs cover the mapped Bengaluru study area only.</p>
      <IndiaCitySelect selectedPlace={selectedPlace} onSelect={onSelectPlace} />
      <form className="scenario-form" onSubmit={submit}>
        <label>
          Preset
          <select value={values.preset} onChange={(event) => {
            if (event.target.value === floodDemoPreset.id) {
              setDraft({ ...values, preset: floodDemoPreset.id, intensity: String(floodDemoPreset.intensity), duration: String(floodDemoPreset.duration) });
              return;
            }
            const preset = scenarios.find((s) => s.scenario_id === event.target.value);
            setDraft(preset ? {
              ...values,
              preset: preset.scenario_id,
              intensity: String(preset.rainfall_intensity_mm_hr),
              duration: String(preset.duration_min),
            } : { ...values, preset: "" });
          }}>
            <option value="">Custom rainfall</option>
            <option value={floodDemoPreset.id}>Flood demo · 200 mm in 2 hours</option>
            {scenarios.map((s) => <option key={s.scenario_id} value={s.scenario_id}>{s.label}</option>)}
          </select>
        </label>
        <div className="scenario-fields">
          <label>
            Intensity <span>(mm/hr)</span>
            <input type="number" min={rainfallLimits.intensity.min} max={rainfallLimits.intensity.max} step="any" required value={values.intensity}
              onChange={(event) => setDraft({ ...values, intensity: event.target.value, preset: "" })} />
          </label>
          <label>
            Duration <span>(min)</span>
            <input type="number" min={rainfallLimits.duration.min} max={rainfallLimits.duration.max} step="any" required value={values.duration}
              onChange={(event) => setDraft({ ...values, duration: event.target.value, preset: "" })} />
          </label>
        </div>
        <label>
          Air-temperature offset (°C)
          <input type="number" min="-20" max="20" step="0.1" required value={values.temperature}
            aria-describedby="temperature-offset-help"
            onChange={(event) => setDraft({ ...values, temperature: event.target.value })} />
        </label>
        <p id="temperature-offset-help" className="scenario-result">Applies a what-if offset to the displayed 2 m air-temperature forecast. It does not change the forecast itself.</p>
        <button className="primary-button" disabled={loading || !supportsSimulation}>
          {loading ? "Running…" : "Run local simulation"}
        </button>
        {!supportsSimulation && <p className="scenario-result" role="status">Local rainfall simulation is available only in its supported study area. Other locations remain available for nationwide weather screening.</p>}
      </form>
      {applied && <p className="scenario-result" role="status"><strong>{applied.floodDemo ? "Flood demo running" : "Rainfall simulation running"}</strong> · {Number(applied.rainfallMm.toFixed(1))} mm in {applied.durationMin} min. Open Car routes to see the effect on a trip.</p>}
      <div className="scenario-actions">
        {(active || loading) && <button type="button" className="pick-button" onClick={stopSimulation}>Stop simulation</button>}
        {active ? <label className="pilot-layer-option">
          <input type="checkbox" checked={showRoads} onChange={() => toggleLayer("cityRoads")} />
          Show local road runoff
        </label> : <p className="scenario-result" role="status">Run a scenario to use its rainfall for road screening.</p>}
      </div>
      {result && (
        <p className="scenario-result" aria-live="polite">
          Local simulation: <strong>{flooded} of {result.road_segments.length}</strong> simulated road segments flooded at {current.intensity} mm/hr for {current.duration} min.
        </p>
      )}
    </section>
  );
}
