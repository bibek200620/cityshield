import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, ApiRequestError, type StormBacktest, type StormBacktestEvent, type StormBacktestSensor } from "../api/client";

const StormComparisonChart = lazy(() => import("./StormComparisonChart"));
const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const depthFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const rainfallFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const tablePageSize = 12;

type LoadState<T> =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: T }
  | { status: "failed"; message: string; code: number | null };

function loadFailure(error: unknown, fallback: string): Extract<LoadState<unknown>, { status: "failed" }> {
  return error instanceof ApiRequestError
    ? { status: "failed", message: error.message, code: error.status }
    : { status: "failed", message: fallback, code: null };
}

function timingLabel(minutes: number | null) {
  if (minutes === null) return "Unavailable";
  if (minutes === 0) return "Same time";
  return `${Math.abs(minutes)} min ${minutes < 0 ? "early" : "late"}`;
}

function ReadingTime({ value }: { value: string }) {
  return <time dateTime={value}>{dateTime.format(new Date(value))} IST</time>;
}

export default function StormComparison() {
  const [catalog, setCatalog] = useState<LoadState<StormBacktestEvent[]>>({ status: "idle" });
  const [comparison, setComparison] = useState<LoadState<StormBacktest>>({ status: "idle" });
  const [eventId, setEventId] = useState("");
  const request = useRef<AbortController | null>(null);
  const events = catalog.status === "ready" ? catalog.data : [];
  const event = events.find((item) => item.event_id === eventId);

  useEffect(() => () => request.current?.abort(), []);

  async function checkEvents() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setCatalog({ status: "loading" });
    setComparison({ status: "idle" });
    try {
      const result = await api.listStormBacktests(controller.signal);
      if (controller.signal.aborted) return;
      setCatalog({ status: "ready", data: result.events });
      const first = result.events.find((item) => item.status === "ready") ?? result.events[0];
      setEventId(first?.event_id ?? "");
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = loadFailure(error, "Could not reach the storm comparison service.");
      setCatalog(failure.code === 404
        ? { ...failure, message: "Imported storm comparisons are unavailable on this server." }
        : failure);
    }
  }

  async function compareEvent() {
    if (event?.status !== "ready") return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setComparison({ status: "loading" });
    try {
      const result = await api.getStormBacktest(event.event_id, controller.signal);
      if (!controller.signal.aborted) setComparison({ status: "ready", data: result });
    } catch (error) {
      if (!controller.signal.aborted) setComparison(loadFailure(error, "Could not load the paired storm readings."));
    }
  }

  return <section className="storm-validation storm-backtest" aria-labelledby="storm-validation-title">
    <div className="storm-backtest-heading">
      <div>
        <h4 id="storm-validation-title">CityShield comparison</h4>
        <p>Compare imported drainage model runs with observations at mapped sensors.</p>
      </div>
      <button type="button" className="secondary-button" disabled={catalog.status === "loading"} onClick={checkEvents}>
        {catalog.status === "loading" ? "Checking…" : catalog.status === "idle" ? "Find imported storms" : "Check again"}
      </button>
    </div>

    {catalog.status === "failed" && <p className="storm-backtest-alert" role="status">{catalog.message}</p>}
    {catalog.status === "ready" && events.length === 0 && <p role="status">
      No storm bundles are installed. A comparison requires matched rainfall and water-level readings, verified sensor mappings, and a drainage model run.
    </p>}
    {events.length > 0 && <div className="storm-backtest-form">
      <label>Imported storm
        <select value={eventId} onChange={(change) => {
          request.current?.abort();
          setEventId(change.target.value);
          setComparison({ status: "idle" });
        }}>
          {events.map((item) => <option key={item.event_id} value={item.event_id}>
            {item.event_id}{item.catchment_id ? ` · ${item.catchment_id}` : ""}{item.status === "unavailable" ? " · Unavailable" : ""}
          </option>)}
        </select>
      </label>
      <button type="button" className="primary-button" onClick={compareEvent}
        disabled={event?.status !== "ready" || comparison.status === "loading"}>
        {comparison.status === "loading" ? "Comparing…" : "Compare storm"}
      </button>
    </div>}
    {event?.status === "unavailable" && <div className="storm-backtest-alert" role="status">
      <strong>Comparison unavailable</strong>
      <p>{event.message ?? "The storm data and model run could not be paired."}</p>
    </div>}
    {comparison.status === "loading" && <p role="status">Loading paired storm readings…</p>}
    {comparison.status === "failed" && <div className="storm-backtest-alert" role="status">
      <strong>{comparison.code === 422 ? "Storm data failed validation" : "Comparison unavailable"}</strong>
      <p>{comparison.message}</p>
    </div>}
    {comparison.status === "ready" && <BacktestResult key={comparison.data.event_id} result={comparison.data} />}
  </section>;
}

function BacktestResult({ result }: { result: StormBacktest }) {
  const [sensorId, setSensorId] = useState(result.sensors[0]?.id ?? "");
  const sensor = result.sensors.find((item) => item.id === sensorId);
  const source = result.model.source_url;

  return <div className="storm-backtest-result">
    <div className="storm-backtest-model">
      <p><strong>{result.model.name}</strong> · Version {result.model.version} · Imported drainage model run</p>
      <p>Catchment {result.catchment_id} · Network {result.network_id} version {result.network_version}</p>
      <p>{result.partition === "holdout" ? "Held-out storm" : "Development storm"} · Storm group {result.storm_group_id}</p>
      <p>Run reference {result.model.run_reference}</p>
      <p className="storm-sources">
        {/^https?:\/\//i.test(result.observation_source.url) && <a href={result.observation_source.url}
          target="_blank" rel="noreferrer">{result.observation_source.title}</a>}
        {source && /^https?:\/\//i.test(source) && <a href={source} target="_blank" rel="noreferrer">Model source</a>}
      </p>
    </div>

    {sensor ? <>
      <label className="storm-backtest-sensor">Sensor
        <select value={sensorId} onChange={(change) => setSensorId(change.target.value)}>
          {result.sensors.map((item) => <option key={item.id} value={item.id}>
            {item.name ? `${item.name} (${item.id})` : item.id}
          </option>)}
        </select>
      </label>
      <SensorComparison key={sensor.id} sensor={sensor} interval={result.interval_minutes} />
    </> : <p role="status">The model run contains no paired sensors for this storm.</p>}

    {result.limitations.length > 0 && <ul className="storm-backtest-limitations">
      {result.limitations.map((item) => <li key={item}>{item}</li>)}
    </ul>}
  </div>;
}

function SensorComparison({ sensor, interval }: { sensor: StormBacktestSensor; interval: number }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const { metrics, series } = sensor;
  const selected = series[selectedIndex];
  const startRow = pageIndex * tablePageSize;
  const endRow = Math.min(startRow + tablePageSize, series.length);

  if (!selected) return <p role="status">This sensor has no paired readings.</p>;

  return <div className="storm-backtest-series">
    <p>Drain node {sensor.node_id} · Gauge {sensor.gauge_id} · {metrics.sample_count} paired readings</p>
    <dl className="storm-backtest-metrics">
      <div>
        <dt>Mean absolute depth error</dt>
        <dd>{depthFormat.format(metrics.mae_m)} m</dd>
      </div>
      <div>
        <dt>Model peak timing</dt>
        <dd>{timingLabel(metrics.peak_timing_error_minutes)}</dd>
      </div>
      <div>
        <dt>Observed peak depth</dt>
        <dd>{depthFormat.format(metrics.observed_peak_m)} m</dd>
        {metrics.observed_peak_at && <dd><ReadingTime value={metrics.observed_peak_at} /></dd>}
      </div>
      <div>
        <dt>Modeled peak depth</dt>
        <dd>{depthFormat.format(metrics.modeled_peak_m)} m</dd>
        {metrics.modeled_peak_at && <dd><ReadingTime value={metrics.modeled_peak_at} /></dd>}
      </div>
    </dl>

    <ul className="storm-backtest-legend" aria-label="Water depth series">
      <li>Observed depth</li>
      <li>Modeled depth</li>
    </ul>
    <Suspense fallback={<p role="status">Preparing timeline charts…</p>}>
      <StormComparisonChart samples={series} selectedAt={selected.timestamp} gaugeId={sensor.gauge_id} />
    </Suspense>
    <p>Each rainfall amount covers the {interval} minutes ending at the displayed time.</p>

    <label className="storm-backtest-timeline">
      <span>Pick a time on the storm timeline</span>
      <input type="range" min={0} max={series.length - 1} value={selectedIndex}
        aria-valuetext={`${dateTime.format(new Date(selected.timestamp))} IST`}
        onChange={(change) => setSelectedIndex(Number(change.target.value))} />
    </label>
    <div className="storm-backtest-reading">
      <p><ReadingTime value={selected.timestamp} /></p>
      <dl>
        <div><dt>Rainfall</dt><dd>{rainfallFormat.format(selected.rainfall_mm)} mm</dd></div>
        <div><dt>Observed depth</dt><dd>{depthFormat.format(selected.observed_depth_m)} m</dd></div>
        <div><dt>Modeled depth</dt><dd>{depthFormat.format(selected.modeled_depth_m)} m</dd></div>
      </dl>
    </div>

    <details className="storm-backtest-readings">
      <summary>Readings table</summary>
      <table aria-label="Paired storm readings">
        <thead><tr>
          <th scope="col">Time</th>
          <th scope="col">Rainfall (mm)</th>
          <th scope="col">Observed (m)</th>
          <th scope="col">Modeled (m)</th>
        </tr></thead>
        <tbody>{series.slice(startRow, endRow).map((sample) => <tr key={sample.timestamp}>
          <th scope="row"><ReadingTime value={sample.timestamp} /></th>
          <td>{rainfallFormat.format(sample.rainfall_mm)}</td>
          <td>{depthFormat.format(sample.observed_depth_m)}</td>
          <td>{depthFormat.format(sample.modeled_depth_m)}</td>
        </tr>)}</tbody>
      </table>
      {series.length > tablePageSize && <div className="storm-backtest-page">
        <button type="button" className="secondary-button" disabled={startRow === 0} onClick={() => setPageIndex(pageIndex - 1)}>Previous rows</button>
        <p role="status">Rows {startRow + 1}–{endRow} of {series.length}</p>
        <button type="button" className="secondary-button" disabled={endRow === series.length} onClick={() => setPageIndex(pageIndex + 1)}>Next rows</button>
      </div>}
    </details>
  </div>;
}
