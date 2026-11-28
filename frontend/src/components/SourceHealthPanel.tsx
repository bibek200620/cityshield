import type { CityFloodResponse } from "../api/client";
import type { useWeatherNowcast } from "../map/weatherNowcast";
import { useFloodStore } from "../store/useFloodStore";
import type { CityHeat } from "./MapView";

type SourceStatus = "Ready" | "Historical" | "Simulated" | "Stale" | "Unavailable" | "Checking" | "Stopped";

const sourceTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? <time dateTime={value}>{sourceTime.format(date)} IST</time> : null;
}

export default function SourceHealthPanel({ nowcast, locationName, flood, heat, heatFailed, retry }: {
  nowcast: ReturnType<typeof useWeatherNowcast>;
  locationName: string;
  flood: CityFloodResponse | null;
  heat: CityHeat | null;
  heatFailed: boolean;
  retry: () => void;
}) {
  const pilot = useFloodStore((s) => s.simulateResult);
  const pilotHeat = useFloodStore((s) => s.heatData);
  const pilotHeatError = useFloodStore((s) => s.heatError);
  const active = useFloodStore((s) => s.simulationActive);
  const loading = useFloodStore((s) => s.loading);
  const weather = nowcast.data;
  const weatherStatus: SourceStatus = weather?.status === "ready" ? (weather.is_stale ? "Stale" : "Ready") : weather?.status === "unavailable" ?
    (weather.reason === "stale_data" ? "Stale" : "Unavailable") : nowcast.error ? "Unavailable" : "Checking";
  const floodStatus: SourceStatus = !active ? "Stopped" : flood?.status === "ready" ? "Simulated" :
    flood?.status === "unavailable" ? "Unavailable" : "Checking";
  const lastForecast = nowcast.lastReadyAt ? <> Last successful retrieval {timestamp(nowcast.lastReadyAt)}.</> : null;
  const rows: { name: string; status: SourceStatus; detail: React.ReactNode }[] = [
    {
      name: "Point weather forecast", status: weatherStatus,
      detail: weather?.status === "ready" ? <>{locationName} model grid point · retrieved {timestamp(weather.provenance.retrieved_at)}</> :
        weather?.status === "unavailable" ? <>{weather.message} Checked {timestamp(weather.checked_at)}.{lastForecast}</> :
        nowcast.error ? <>The weather API could not be reached.{lastForecast}</> : "Checking the city-point forecast.",
    },
    {
      name: "Municipal runoff", status: floodStatus,
      detail: flood?.status === "ready" && active ? <>{flood.source} · {flood.grid_m} m grid · {flood.rainfall_mm.toFixed(1)} mm input</> :
        active && flood?.status === "unavailable" ? flood.message : "Applies the current rainfall scenario within the GBA boundary.",
    },
    {
      name: "Municipal Landsat", status: heat ? "Historical" : heatFailed ? "Unavailable" : "Checking",
      detail: heat ? <>USGS scene <time dateTime={heat.date}>{heat.date}</time> · {heat.resolution_m} m display grid</> :
        heatFailed ? "The bundled city-scale scene could not load." : "Checking the bundled city-scale scene.",
    },
    {
      name: "Bellandur flood model", status: pilot ? "Simulated" : !active ? "Stopped" : loading ? "Checking" : "Unavailable",
      detail: pilot ? <>{pilot.is_synthetic_ward ? "Synthetic reference network" : "Mapped reference network"} · run {timestamp(pilot.generated_at_utc)}</> :
        "Outputs are available after the pilot completes a scenario.",
    },
    {
      name: "Bellandur heat inputs", status: pilotHeat?.status === "ready" ? "Historical" :
        pilotHeat?.status === "unavailable" || pilotHeatError ? "Unavailable" : "Checking",
      detail: pilotHeat?.status === "ready" ? "Local Landsat pixels support the combined exposure workflow." :
        "Combined exposure depends on a compatible local Landsat scene and model.",
    },
  ];

  return <section className="source-health" aria-labelledby="source-health-title">
    <div className="evidence-section-heading">
      <h3 id="source-health-title">Source status</h3>
      <button className="secondary-button" type="button" onClick={retry}>Refresh sources</button>
    </div>
    <ul>
      {rows.map(({ name, status, detail }) => <li key={name}>
        <strong>{name}</strong>
        <span className="source-state" data-state={status}>{status}</span>
        <p>{detail}</p>
      </li>)}
    </ul>
  </section>;
}
