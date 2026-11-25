import { Fragment } from "react";
import { useFloodStore } from "../store/useFloodStore";

export default function HeatProvenancePanel() {
  const heat = useFloodStore((s) => s.heatData);
  const heatError = useFloodStore((s) => s.heatError);
  const flood = useFloodStore((s) => s.simulateResult);
  const exposure = useFloodStore((s) => s.combinedExposure);

  return (
    <div className="detail-content">
      <h3>Flood simulation</h3>
      {flood ? <>
        <p>{flood.model_version} · {flood.model_mode} · {flood.rainfall_source}</p>
        <p>Run at {new Date(flood.generated_at_utc).toLocaleString()}</p>
        <ul>{flood.input_provenance.map((item) => <li key={item}>{item}</li>)}</ul>
        <p>{flood.model_caveat}</p>
      </> : <p>Run a rainfall simulation to see its inputs and model details.</p>}
      <p>Historical validation against observed flood events is unavailable.</p>

      <h3>Landsat heat</h3>
      <p>{heatError ?? heat?.message ?? "Landsat heat data unavailable."}</p>
      {heat && <p>{heat.source}</p>}
      {heat?.scene_id && <p className="break-all">{heat.scene_id}</p>}
      {heat?.model_version && <p>XGBoost {heat.model_version} · {heat.crs} · {heat.pixel_resolution_m} m pixels</p>}
      {heat?.generated_at_utc && <p>Inference at {new Date(heat.generated_at_utc).toLocaleString()}</p>}
      {heat?.hotspot_threshold_c != null && <p>Scene hotspot cutoff: {heat.hotspot_threshold_c.toFixed(1)} °C</p>}
      {heat?.explanation_message && <p>{heat.explanation_message}</p>}
      {heat?.explanation_status === "available" && (
        <dl aria-label="Mean absolute TreeSHAP contributions">
          {Object.entries(heat.feature_mean_abs_shap_c).map(([feature, value]) => (
            <Fragment key={feature}><dt>{feature}</dt><dd>{value.toFixed(2)} °C</dd></Fragment>
          ))}
        </dl>
      )}
      <p>Heatwave forecast unavailable in this prototype.</p>

      <h3>Combined exposure</h3>
      <p>A cell qualifies when simulated depth reaches 15 cm and modelled surface temperature falls in the top 10% of this scene.</p>
      {exposure && <p>Grid: {exposure.grid_crs} · {exposure.grid_resolution_m} m</p>}
    </div>
  );
}
