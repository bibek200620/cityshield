import { useFloodStore } from "../store/useFloodStore";

export default function FloodProvenancePanel() {
  const flood = useFloodStore((state) => state.simulateResult);

  return <div className="detail-content">
    <h3>Flood simulation</h3>
    {flood ? <>
      <p>{flood.model_version} · {flood.model_mode} · {flood.rainfall_source}</p>
      <p>Run at {new Date(flood.generated_at_utc).toLocaleString()}</p>
      <ul>{flood.input_provenance.map((item) => <li key={item}>{item}</li>)}</ul>
      <p>{flood.model_caveat}</p>
    </> : <p>Run a rainfall simulation to see its inputs and model details.</p>}
    <p>Historical validation against observed flood events is unavailable.</p>
  </div>;
}
