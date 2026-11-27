import { useCallback, useEffect, useState } from "react";
import { api, type AssistantOutlook, type TwoDayWeatherReportResponse } from "../api/client";
import { summarizeHourly } from "../map/weatherReport";
import Icon from "./Icon";

const bengaluruTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});
const localHour = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const formatTime = (value: string) => bengaluruTime.format(new Date(value));

function downloadForecast(report: Extract<TwoDayWeatherReportResponse, { status: "ready" }>) {
  const { grid_cell_center: grid, retrieved_at: retrievedAt } = report.provenance;
  const fields = ["valid_at_utc", "valid_at_ist", "air_temperature_c", "feels_like_c", "precipitation_mm",
    "relative_humidity_pct", "grid_latitude", "grid_longitude", "retrieved_at_utc", "source"];
  const rows = report.hourly_forecast.map((hour) => [
    new Date(hour.valid_at).toISOString(), bengaluruTime.format(new Date(hour.valid_at)),
    hour.air_temperature_c, hour.feels_like_c, hour.precipitation_mm, hour.relative_humidity_pct,
    grid.latitude, grid.longitude, new Date(retrievedAt).toISOString(), "Open-Meteo model estimate",
  ]);
  const csv = [fields, ...rows].map((row) => row.map((field) =>
    typeof field === "number" ? field : `"${field.replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv + "\r\n"], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `cityshield-bengaluru-48h-${report.forecast_from.slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function TwoDayWeatherReport({ outlook }: { outlook: AssistantOutlook | null }) {
  const [report, setReport] = useState<TwoDayWeatherReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadReport = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    setError(null);
    try {
      setReport(await api.getWeatherReport(signal));
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "The weather report could not load.");
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadReport(controller.signal);
    return () => controller.abort();
  }, [loadReport]);

  return (
    <div className="weather-report-section">
      <div className="weather-report-heading">
        <div>
          <h3>Greater Bengaluru</h3>
          <p>48-hour forecast · India Standard Time</p>
        </div>
        <div className="weather-report-actions">
          <button type="button" className="pick-button" disabled={refreshing} onClick={() => void loadReport()}>
            {refreshing ? "Updating…" : "Refresh report"}
          </button>
          {report?.status === "ready" && <button type="button" className="secondary-button"
            disabled={refreshing} onClick={() => downloadForecast(report)}>Export CSV</button>}
        </div>
      </div>

      {refreshing && !report && <p role="status">Loading the next 48 forecast hours…</p>}
      {error && <p className="route-error" role="alert">{error}</p>}
      {report?.status === "unavailable" && <div className="weather-report-unavailable" role="status">
        <strong>Two-day forecast unavailable</strong>
        <p>{report.message}</p>
      </div>}
      {report?.status === "ready" && <>
        <section className="weather-report-watch" aria-label="Three-hour flood and heat screening">
          <h3>Next 3 hours</h3>
          <div data-warning={outlook?.status === "ready" && Boolean(outlook.alert)}>
            <Icon name="flood" /><span><strong>Flood screening</strong>
              {outlook?.status === "ready" && outlook.alert ? `${outlook.alert.cells} modeled cells reach the runoff threshold by ${localHour.format(new Date(outlook.alert.valid_at))}.`
                : outlook?.status === "ready" && outlook.flood_screen_available !== false ? "The forecast stays below the city watch threshold." : "City runoff screening unavailable."}</span>
          </div>
          <div data-warning={outlook?.status === "ready" && Boolean(outlook.heat)}>
            <Icon name="heat" /><span><strong>Heat screening</strong>
              {outlook?.status === "ready" && outlook.heat ? `${outlook.heat.feels_like_c.toFixed(1)} °C feels like at ${localHour.format(new Date(outlook.heat.valid_at))}.`
                : outlook?.status === "ready" ? "The forecast stays below the 40 °C feels-like threshold." : "Heat screening unavailable."}</span>
          </div>
        </section>
        <RainTimeline hours={report.hourly_forecast} />
        <div className="weather-report-days">
          {[report.hourly_forecast.slice(0, 24), report.hourly_forecast.slice(24, 48)].map((hours, index) => {
            const summary = summarizeHourly(hours);
            return <article className="weather-report-day" key={index}>
              <h3>{index === 0 ? "Next 24 hours" : "24–48 hours"}</h3>
              <p>{formatTime(hours[0].valid_at)} – {formatTime(hours[hours.length - 1].valid_at)}</p>
              <dl>
                <div><dt>Air temperature</dt><dd>{summary.low.toFixed(1)}–{summary.high.toFixed(1)} °C</dd></div>
                <div><dt>Peak feels like</dt><dd>{summary.feelsHigh.toFixed(1)} °C</dd></div>
                <div><dt>Rain total</dt><dd>{summary.rain.toFixed(1)} mm</dd></div>
                <div><dt>Mean humidity</dt><dd>{Math.round(summary.humidity)}%</dd></div>
              </dl>
            </article>;
          })}
        </div>
        <details className="weather-report-hourly">
          <summary>Show all 48 hourly estimates</summary>
          <ol>
            {report.hourly_forecast.map((hour) => <li key={hour.valid_at}>
              <time dateTime={hour.valid_at}>{bengaluruTime.format(new Date(hour.valid_at))} IST</time>
              <span>{hour.air_temperature_c.toFixed(1)} °C air · {hour.feels_like_c.toFixed(1)} °C feels like</span>
              <span>{hour.precipitation_mm.toFixed(1)} mm rain · {Math.round(hour.relative_humidity_pct)}% humidity</span>
            </li>)}
          </ol>
        </details>
        <footer className="weather-report-source">
          <p><a href="https://open-meteo.com/">Open-Meteo</a> · Model grid at {report.provenance.grid_cell_center.latitude.toFixed(3)}° N, {report.provenance.grid_cell_center.longitude.toFixed(3)}° E. Retrieved {formatTime(report.provenance.retrieved_at)} IST.</p>
          {outlook?.status === "ready" && <p>City screening uses {outlook.forecast_points ?? 1} weather-model grid {(outlook.forecast_points ?? 1) === 1 ? "point" : "points"}.</p>}
          <p>For official weather warnings, see <a href="https://mausam.imd.gov.in/bengaluru/">IMD Met Centre Bengaluru</a>.</p>
        </footer>
      </>}
    </div>
  );
}

function RainTimeline({ hours }: { hours: Extract<TwoDayWeatherReportResponse, { status: "ready" }>["hourly_forecast"] }) {
  const { rain, firstWet, peak } = summarizeHourly(hours);
  const maximum = Math.max(1, Math.ceil(peak?.precipitation_mm ?? 0));
  return <section className="rain-timeline" aria-label="Hourly rain outlook">
    <div className="rain-timeline-heading">
      <div><h3>Rain outlook</h3><p>{rain > 0 && peak && firstWet
        ? `Rain from ${formatTime(firstWet.valid_at)}. Peak ${peak.precipitation_mm.toFixed(1)} mm at ${formatTime(peak.valid_at)}.`
        : "The model shows no measurable rain in this window."}</p></div>
      <div className="rain-total"><strong>{rain.toFixed(1)} <small>mm</small></strong><span>48-hour total</span></div>
    </div>
    <div className="rain-chart" aria-hidden="true">
      <div className="rain-chart-scale"><span>{maximum} mm</span><span>0</span></div>
      <div className="rain-chart-bars">
        {hours.map((hour, index) => <span key={hour.valid_at} data-later={index >= 24}
          title={`${formatTime(hour.valid_at)} · ${hour.precipitation_mm.toFixed(1)} mm`}
          style={{ height: `${100 * hour.precipitation_mm / maximum}%` }} />)}
      </div>
    </div>
    <div className="rain-chart-labels"><span>{formatTime(hours[0].valid_at)}</span><span>+24 hr</span><span>+48 hr</span></div>
  </section>;
}
