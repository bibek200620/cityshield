import type { CityFloodResponse, LatLng } from "../api/client";
import { useFloodStore } from "../store/useFloodStore";
import { useWeatherNowcast } from "../map/weatherNowcast";

type SourceStatus = "Ready" | "Historical" | "Simulated" | "Stale" | "Unavailable" | "Checking" | "Stopped";

const sourceTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? <time dateTime={value}>{sourceTime.format(date)} IST</time> : null;
}

export default function SourceHealthPanel({ location, flood, retry }: {
  location: LatLng;
  flood: CityFloodResponse | null;
  retry: () => void;
}) {
  const nowcast = useWeatherNowcast(location);
  const pilot = useFloodStore((s) => s.simulateResult);
  const active = useFloodStore((s) => s.simulationActive);
  const loading = useFloodStore((s) => s.loading);
  const rainfall = useFloodStore((s) => s.currentRainfall);
  const rainfallTotalMm = rainfall.intensity * rainfall.duration / 60;
  const weather = nowcast.data;
  const weatherStatus: SourceStatus = weather?.status === "ready" ? "Ready" : weather?.status === "unavailable" ?
    (weather.reason === "stale_data" ? "Stale" : "Unavailable") : nowcast.error ? "Unavailable" : "Checking";
  const floodStatus: SourceStatus = !active ? "Stopped" : flood?.status === "ready" ? "Simulated" :
    flood?.status === "unavailable" ? "Unavailable" : "Checking";
  const lastForecast = nowcast.lastReadyAt ? <> Last successful retrieval {timestamp(nowcast.lastReadyAt)}.</> : null;
  const rows: { name: string; status: SourceStatus; detail: React.ReactNode }[] = [
    {
      name: "Weather forecast", status: weatherStatus,
      detail: weather?.status === "ready" ? <>Selected-area model grid point · retrieved {timestamp(weather.provenance.retrieved_at)}</> :
        weather?.status === "unavailable" ? <>{weather.message} Checked {timestamp(weather.checked_at)}.{lastForecast}</> :
        nowcast.error ? <>The weather API could not be reached.{lastForecast}</> : "Checking the city-point forecast.",
    },
    {
      name: "Municipal runoff", status: floodStatus,
      detail: flood?.status === "ready" && active ? <>{flood.source} · {flood.grid_m} m grid · {flood.rainfall_mm.toFixed(1)} mm input</> :
        active && flood?.status === "unavailable" ? `${rainfallTotalMm.toFixed(1)} mm input · ${flood.message}` :
        `${rainfallTotalMm.toFixed(1)} mm input · ${active ? "waiting for the local runoff screen" : "calculation stopped"}`,
    },
    {
      name: "Surface-temperature imagery", status: "Historical",
      detail: "Daily daytime satellite imagery is available as a separate map layer. It is not a numeric per-hex reading or an air-temperature forecast.",
    },
    {
      name: "Bellandur flood model", status: pilot ? "Simulated" : !active ? "Stopped" : loading ? "Checking" : "Unavailable",
      detail: pilot ? <>{pilot.is_synthetic_ward ? "Synthetic reference network" : "Mapped reference network"} · run {timestamp(pilot.generated_at_utc)}</> :
        "Outputs are available after the pilot completes a scenario.",
    },
    {
      name: "Local heat-model inputs", status: "Unavailable",
      detail: "Numeric local surface-temperature and calibrated heat-model inputs are not connected.",
    },
  ];

  return <section className="source-health" aria-labelledby="source-health-title">
    <div className="evidence-section-heading">
      <h3 id="source-health-title">Source status</h3>
      <button className="secondary-button" type="button" onClick={() => { nowcast.refresh(); retry(); }}>Refresh sources</button>
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
