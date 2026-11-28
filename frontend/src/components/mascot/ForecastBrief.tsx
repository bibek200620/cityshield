import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type LatLng, type TwoDayWeatherReportResponse } from "../../api/client";
import { summarizeHourly } from "../../map/weatherReport";

const ist = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", weekday: "short", hour: "numeric", minute: "2-digit",
});
const time = (value: string) => ist.format(new Date(value));

export default function ForecastBrief({ onRead, autoSpeak, location, locationName }: {
  onRead?: (brief: string) => void; autoSpeak: boolean; location: LatLng; locationName: string;
}) {
  const [duration, setDuration] = useState("10");
  const [report, setReport] = useState<{
    hours: number; response: Extract<TwoDayWeatherReportResponse, { status: "ready" }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const hours = Number(duration);
    if (!Number.isInteger(hours) || hours < 1 || hours > 48) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setReport(null);
    setError("");
    try {
      const response = await api.getWeatherReport(controller.signal, location);
      if (controller.signal.aborted) return;
      if (response.status === "unavailable") {
        setError(response.message);
      } else if (response.hourly_forecast.length < hours) {
        setError("The forecast service returned fewer hours than requested.");
      } else {
        setReport({ hours, response });
        if (autoSpeak) {
          const values = summarizeHourly(response.hourly_forecast.slice(0, hours));
          onRead?.(spokenForecast(hours, values, locationName));
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Forecast unavailable.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const hourly = report?.response.hourly_forecast.slice(0, report.hours);
  const values = hourly && summarizeHourly(hourly);

  return (
    <div className="mascot-tool" aria-label={`${locationName} forecast report`}>
      <form className="mascot-form" onSubmit={(event) => { void generate(event); }}>
        <label htmlFor="cx-forecast-hours">Forecast duration in hours</label>
        <div className="mascot-duration">
          <input id="cx-forecast-hours" type="number" min={1} max={48} step={1} required value={duration}
            disabled={loading} onChange={(event) => setDuration(event.target.value)} />
          <button type="submit" className="mascot-primary" disabled={loading}>Get report</button>
        </div>
      </form>
      {loading && <p role="status">Loading the forecast…</p>}
      {error && <p className="mascot-error" role="alert">{error}</p>}
      {report && hourly && values && <section className="mascot-result" aria-label="Completed forecast report">
        <div className="mascot-result-title">
          <h3>Next {report.hours} {report.hours === 1 ? "hour" : "hours"}</h3>
          {onRead && <button type="button" className="mascot-secondary"
            onClick={() => onRead(spokenForecast(report.hours, values, locationName))}>Read report</button>}
        </div>
        <p>{time(hourly[0].valid_at)} to {time(hourly[hourly.length - 1].valid_at)} IST</p>
        <dl className="mascot-metrics">
          <div><dt>Precipitation</dt><dd>{values.rain.toFixed(1)} mm</dd></div>
          <div><dt>Air temperature</dt><dd>{values.low.toFixed(1)}–{values.high.toFixed(1)} °C</dd></div>
          <div><dt>Feels like</dt><dd>{values.feelsLow.toFixed(1)}–{values.feelsHigh.toFixed(1)} °C</dd></div>
          <div><dt>Mean humidity</dt><dd>{Math.round(values.humidity)}%</dd></div>
        </dl>
        {values.firstWet && values.peak ? <p>
          Precipitation first appears in the hour ending {time(values.firstWet.valid_at)} IST.
          The wettest hour is projected to end at {time(values.peak.valid_at)} IST with {values.peak.precipitation_mm.toFixed(1)} mm.
        </p> : <p>No measurable precipitation in this forecast window.</p>}
        <details className="mascot-hourly">
          <summary>Show {report.hours} hourly estimates</summary>
          <table>
            <thead><tr><th scope="col">Hour ends (IST)</th><th scope="col">Air</th><th scope="col">Feels</th><th scope="col">Precip.</th><th scope="col">RH</th></tr></thead>
            <tbody>{hourly.map((hour) => <tr key={hour.valid_at}>
              <th scope="row"><time dateTime={hour.valid_at}>{time(hour.valid_at)}</time></th>
              <td>{hour.air_temperature_c.toFixed(1)}°</td><td>{hour.feels_like_c.toFixed(1)}°</td>
              <td>{hour.precipitation_mm.toFixed(1)} mm</td><td>{Math.round(hour.relative_humidity_pct)}%</td>
            </tr>)}</tbody>
          </table>
        </details>
        <p>Retrieved {time(report.response.provenance.retrieved_at)} IST. City-scale model forecast.</p>
      </section>}
    </div>
  );
}

function spokenForecast(hours: number, values: ReturnType<typeof summarizeHourly>, locationName: string) {
  const span = hours === 1 ? "hour" : `${hours} hours`;
  const rain = values.firstWet && values.peak
    ? `${values.rain.toFixed(1)} millimetres of precipitation are forecast. The wettest hour ends at ${time(values.peak.valid_at)}, India Standard Time.`
    : "There is no measurable precipitation in this forecast window.";
  return `${locationName} forecast for the next ${span}. ${rain} Air temperature ranges from ${Math.round(values.low)} to ${Math.round(values.high)} degrees Celsius, with average humidity of ${Math.round(values.humidity)} percent.`;
}
