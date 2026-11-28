import type { CityFloodResponse } from "../api/client";
import { useFloodStore } from "../store/useFloodStore";
import type { summarizeWardHeat, summarizeWardRunoff, WardEvidence } from "../map/wardEvidence";
import type { CityHeat } from "./MapView";
import type { BengaluruPlace } from "./PlaceSearch";
import Icon from "./Icon";

export interface WardSummary {
  evidence: WardEvidence;
  runoff: ReturnType<typeof summarizeWardRunoff> | null;
  heat: ReturnType<typeof summarizeWardHeat> | null;
}

export default function WardInspector({ place, summary, flood, heat, failed, onRetry, onCompare }: {
  place: BengaluruPlace;
  summary: WardSummary | null;
  flood: CityFloodResponse | null;
  heat: CityHeat | null;
  failed: boolean;
  onRetry: () => void;
  onCompare: (trigger: HTMLButtonElement) => void;
}) {
  const active = useFloodStore((s) => s.simulationActive);
  const heatOffset = useFloodStore((s) => s.heatOffsetC);
  const runoff = summary?.runoff;
  const surface = summary?.heat;
  const comparisonArea = runoff?.highAreaPercent;

  return <section className="console-section ward-inspector" aria-labelledby="ward-inspector-title">
    <h2 id="ward-inspector-title" className="sidebar-heading" tabIndex={-1}><Icon name="extent" /> Ward analysis</h2>
    <h3>{place.name}</h3>
    <p>{place.corporation} corporation · Ward {place.id.split(":")[1]}</p>
    {!summary && <div className="ward-status" role="status">
      {failed ? <>Ward geometry or grid overlaps could not load. <button className="pick-button" type="button" onClick={onRetry}>Retry</button></> :
        "Loading ward geometry and grid overlaps…"}
    </div>}
    {summary && <>
      <dl className="ward-readings" aria-label="Ward measurements">
        <div><dt>Ward area</dt><dd>{(summary.evidence.area_m2 / 1_000_000).toFixed(2)} km²</dd></div>
        <div><dt>Mean runoff</dt><dd>{runoff?.mean == null ? "—" : `${runoff.mean.toFixed(1)} mm`}</dd></div>
        <div><dt>Scored area above 20 mm</dt><dd>{comparisonArea == null ? "—" : `${comparisonArea.toFixed(1)}%`}</dd></div>
        <div><dt>Mean surface temperature</dt><dd>{surface?.mean == null ? "Unavailable" : `${(surface.mean + heatOffset).toFixed(1)} °C`}</dd></div>
      </dl>
      {comparisonArea != null && <div className="ward-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, comparisonArea)}%` }} />
      </div>}
      <p className="ward-method">{runoff?.mean != null ? `${runoff.areaKm2.toFixed(2)} km² of grid has a runoff value.` :
        !active ? "Rainfall scenario stopped." : flood?.status === "unavailable" ? "Municipal runoff unavailable." :
          flood?.status === "ready" ? "No runoff values intersect this ward." : "Waiting for the current runoff screen."}
        {surface?.mean != null && heat ? ` Satellite scene ${heat.date}, ${surface.areaKm2.toFixed(2)} km² of display grid${heatOffset ? " with scenario offset" : ""}.` : ""}
      </p>
    </>}
    <button type="button" className="text-action" onClick={(event) => onCompare(event.currentTarget)}>
      Compare this ward <Icon name="chevron" />
    </button>
  </section>;
}
