import { useState, type FormEvent } from "react";
import { floodDemoPreset, useFloodStore } from "../store/useFloodStore";
import IndiaCitySelect from "./IndiaCitySelect";
import { supportsBengaluruSimulation, type MapPlace } from "../map/places";

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
  const [draft, setDraft] = useState<{ intensity: string; duration: string; preset: string; air: string; surface: string } | null>(null);
  const selectedPresetId = useFloodStore((s) => s.selectedPresetId);
  const supportsSimulation = supportsBengaluruSimulation(selectedPlace);
  const values = draft ?? { intensity: String(current.intensity), duration: String(current.duration), preset: selectedPresetId ?? "", air: String(heatOffset), surface: String(surfaceOffset) };
  const flooded = result?.road_segments.filter((segment) => segment.state === "flooded").length;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supportsSimulation) return;
    const offsets = { air: Number(values.air), surface: Number(values.surface) };
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
            <input type="number" min="5" max="150" step="any" required value={values.intensity}
              onChange={(event) => setDraft({ ...values, intensity: event.target.value, preset: "" })} />
          </label>
          <label>
            Duration <span>(min)</span>
            <input type="number" min="15" max="180" step="any" required value={values.duration}
              onChange={(event) => setDraft({ ...values, duration: event.target.value, preset: "" })} />
          </label>
        </div>
        <details className="scenario-advanced">
          <summary>Temperature settings</summary>
          <label>
            Air-temperature offset (°C)
            <input type="number" min="-20" max="20" step="0.1" required value={values.air}
              aria-describedby="temperature-offset-help"
              onInvalid={(event) => { event.currentTarget.closest("details")?.setAttribute("open", ""); }}
              onChange={(event) => setDraft({ ...values, air: event.target.value })} />
          </label>
          <p id="temperature-offset-help" className="scenario-result">Applies a what-if offset to the displayed 2 m air-temperature forecast and India combined screen.</p>
          <label>
            Landsat surface-temperature offset (°C)
            <input type="number" min="-20" max="20" step="0.1" required value={values.surface}
              aria-describedby="surface-offset-help"
              onInvalid={(event) => { event.currentTarget.closest("details")?.setAttribute("open", ""); }}
              onChange={(event) => setDraft({ ...values, surface: event.target.value })} />
          </label>
          <p id="surface-offset-help" className="scenario-result">Applies to the historical Bengaluru Landsat display and ward analysis.</p>
        </details>
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
        </label> : <p className="scenario-result" role="status">Simulation stopped. Run a scenario to show its layers again.</p>}
      </div>
      {result && (
        <p className="scenario-result" aria-live="polite">
          Local simulation: <strong>{flooded} of {result.road_segments.length}</strong> simulated road segments flooded at {current.intensity} mm/hr for {current.duration} min.
        </p>
      )}
    </section>
  );
}
