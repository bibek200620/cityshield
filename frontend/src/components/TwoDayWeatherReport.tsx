import { useCallback, useEffect, useState } from "react";
import { api, type TwoDayWeatherReportResponse } from "../api/client";
import { summarizeHourly } from "../map/weatherReport";

const bengaluruTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

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

export default function TwoDayWeatherReport() {
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
        <p>48 hourly estimates for Bengaluru</p>
        <button type="button" className="pick-button" disabled={refreshing} onClick={() => void loadReport()}>
          {refreshing ? "Updating…" : "Refresh report"}
        </button>
      </div>
      {report?.status === "ready" && <button type="button" className="secondary-button weather-export"
        disabled={refreshing} onClick={() => downloadForecast(report)}>Export CSV</button>}

      {refreshing && !report && <p role="status">Loading the next 48 forecast hours…</p>}
      {error && <p className="route-error" role="alert">{error}</p>}
      {report?.status === "unavailable" && <div className="weather-report-unavailable" role="status">
        <strong>Two-day forecast unavailable</strong>
        <p>{report.message}</p>
      </div>}
      {report?.status === "ready" && <>
        <p className="weather-report-provenance">
          {report.source} · 2 m air temperature · hourly precipitation · Bengaluru grid cell {report.provenance.grid_cell_center.latitude.toFixed(3)}, {report.provenance.grid_cell_center.longitude.toFixed(3)}. Retrieved {bengaluruTime.format(new Date(report.provenance.retrieved_at))} IST.
        </p>
        <div className="weather-report-days">
          {[report.hourly_forecast.slice(0, 24), report.hourly_forecast.slice(24, 48)].map((hours, index) => {
            const summary = summarizeHourly(hours);
            return <article className="weather-report-day" key={index}>
              <h3>{index === 0 ? "Next 24 hours" : "24–48 hours"}</h3>
              <p>{bengaluruTime.format(new Date(hours[0].valid_at))} – {bengaluruTime.format(new Date(hours[hours.length - 1].valid_at))} IST</p>
              <dl>
                <div><dt>Air temperature</dt><dd>{summary.low.toFixed(1)}–{summary.high.toFixed(1)} °C</dd></div>
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
        <p className="weather-report-limits">
          This is a third-party forecast for a coarse Bengaluru grid point, not street-level observation, a CityShield-trained forecast, or an official warning. It does not forecast flood depths. Landsat surface temperature is not an air-temperature or heatwave forecast.
        </p>
        <p className="outlook-attribution">Provider: <a href="https://open-meteo.com/">Open-Meteo</a></p>
      </>}
    </div>
  );
}
