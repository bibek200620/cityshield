import { useFloodStore } from "../store/useFloodStore";

export default function KpiStatsRow() {
  const rainfall = useFloodStore((state) => state.currentRainfall);
  const result = useFloodStore((state) => state.simulateResult);
  const facilities = useFloodStore((state) => state.criticalInfra);
  const roads = result?.road_segments ?? [];
  const flooded = roads.filter((road) => road.state === "flooded").length;
  const atRisk = roads.filter((road) => road.state === "at_risk").length;
  const facilitiesAtRisk = result?.at_risk_infra_ids.length ?? 0;
  const cards = [
    { label: "Scenario rainfall input", value: `${rainfall.intensity} mm/hr`, detail: `${rainfall.duration} minute scenario` },
    { label: "Simulated road segments at risk", value: String(flooded + atRisk), detail: `${roads.length} road segments in current output` },
    { label: "Simulated flooded segments", value: String(flooded), detail: `Depth class threshold: ≥ 0.30 m` },
    { label: "Facilities with simulated access risk", value: String(facilitiesAtRisk), detail: `${facilities.length} input facilities` },
  ];

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 px-5 py-3 bg-[#061120] border-b border-[#11263d]" aria-label="Current simulation summary">
      {cards.map((card) => (
        <div key={card.label} className="bg-[#0c1e33] border border-[#173454] rounded-xl p-3.5">
          <div className="text-[11.5px] font-semibold text-slate-300">{card.label}</div>
          <div className="text-2xl font-black text-white leading-tight">{card.value}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{card.detail}</div>
        </div>
      ))}
      <p className="col-span-2 xl:col-span-4 text-[10px] text-amber-200">
        Simulation output only. These counts are model-derived and are not observed flood reports.
      </p>
    </div>
  );
}
