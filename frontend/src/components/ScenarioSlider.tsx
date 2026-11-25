import { useState, type FormEvent } from "react";
import { useFloodStore } from "../store/useFloodStore";

export default function ScenarioSlider() {
  const scenarios = useFloodStore((s) => s.scenarios);
  const current = useFloodStore((s) => s.currentRainfall);
  const result = useFloodStore((s) => s.simulateResult);
  const runScenario = useFloodStore((s) => s.runScenario);
  const runCustomRainfall = useFloodStore((s) => s.runCustomRainfall);
  const loading = useFloodStore((s) => s.loading);
  const [draft, setDraft] = useState<{ intensity: string; duration: string; preset: string } | null>(null);
  const selectedPresetId = useFloodStore((s) => s.selectedPresetId);
  const values = draft ?? { intensity: String(current.intensity), duration: String(current.duration), preset: selectedPresetId ?? "" };
  const flooded = result?.road_segments.filter((segment) => segment.state === "flooded").length;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (values.preset) {
      void runScenario(values.preset);
    } else {
      void runCustomRainfall(Number(values.intensity), Number(values.duration));
    }
  }

  return (
    <section aria-label="Rainfall inputs">
      <p className="scenario-result">Updates city flood screening and the Bellandur simulation.</p>
      <form className="scenario-form" onSubmit={submit}>
        <label>
          Preset
          <select value={values.preset} onChange={(event) => {
            const preset = scenarios.find((s) => s.scenario_id === event.target.value);
            setDraft(preset ? {
              preset: preset.scenario_id,
              intensity: String(preset.rainfall_intensity_mm_hr),
              duration: String(preset.duration_min),
            } : { ...values, preset: "" });
          }}>
            <option value="">Custom rainfall</option>
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
        <button className="primary-button" disabled={loading}>
          {loading ? "Running…" : "Run flood simulation"}
        </button>
      </form>
      {result && (
        <p className="scenario-result" aria-live="polite">
          Bellandur pilot: <strong>{flooded} of {result.road_segments.length}</strong> simulated road segments flooded at {current.intensity} mm/hr for {current.duration} min.
        </p>
      )}
    </section>
  );
}
