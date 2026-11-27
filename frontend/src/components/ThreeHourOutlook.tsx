import { useEffect, useRef, useState } from "react";
import { api, type AssistantOutlook, type LatLng, type WeatherAvailabilityResponse } from "../api/client";
import Icon, { type IconName } from "./Icon";
import TwoDayWeatherReport from "./TwoDayWeatherReport";

const bengaluruTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const timeLabel = (timestamp: string) => bengaluruTime.format(new Date(timestamp));
const degrees = (value: number) => `${Math.round(value)}°`;

type Condition = {
  label: string;
  sky: "clear" | "night" | "clouds" | "rain" | "snow" | "neutral";
  icon: IconName;
};

function condition(code?: number | null, isDay?: number | null): Condition {
  if (code === 0 || code === 1) {
    if (isDay === 0) return { label: code === 0 ? "Clear night" : "Mainly clear", sky: "night", icon: "moon" };
    return { label: code === 0 ? "Clear sky" : "Mainly clear", sky: "clear", icon: "heat" };
  }
  if (code === 2) return { label: "Partly cloudy", sky: "clouds", icon: "partly" };
  if (code === 3) return { label: "Overcast", sky: "clouds", icon: "cloud" };
  if (code === 45 || code === 48) return { label: "Fog", sky: "clouds", icon: "cloud" };
  if (code === 71 || code === 73 || code === 75 || code === 77 || code === 85 || code === 86) {
    return { label: "Snow", sky: "snow", icon: "snow" };
  }
  if (code === 95 || code === 96 || code === 97 || code === 99) {
    return { label: "Thunderstorms", sky: "rain", icon: "rain" };
  }
  if (code === 51 || code === 53 || code === 55 || code === 56 || code === 57) {
    return { label: "Drizzle", sky: "rain", icon: "rain" };
  }
  if (code === 61 || code === 63 || code === 65 || code === 66 || code === 67 || code === 80 || code === 81 || code === 82) {
    return { label: "Rain", sky: "rain", icon: "rain" };
  }
  return { label: "Condition unavailable", sky: "neutral", icon: "thermometer" };
}

export default function ThreeHourOutlook({ open, onOpen, onClose, outlook, location, locationName = "India" }: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  outlook: AssistantOutlook | null;
  location?: LatLng;
  locationName?: string;
}) {
  const [weather, setWeather] = useState<WeatherAvailabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const [paused, setPaused] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const latitude = location?.lat;
  const longitude = location?.lng;
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getWeatherNowcast(controller.signal, latitude !== undefined && longitude !== undefined
      ? { lat: latitude, lng: longitude } : undefined)
      .then((result) => {
        if (!controller.signal.aborted) setWeather(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "The outlook could not load.");
        }
      });
    return () => controller.abort();
  }, [request, latitude, longitude]);

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) {
      dialog.current.scrollTop = 0;
      dialog.current.showModal();
    }
  }, [open]);

  const forecast = weather?.status === "ready" ? weather : null;
  const current = condition(forecast?.weather_code, forecast?.is_day);
  const animated = current.sky !== "neutral" && current.sky !== "night";
  const unavailable = error ?? (weather?.status === "unavailable" ? weather.message : null);

  return (
    <>
      <button ref={preview} type="button" className="weather-preview" data-sky={current.sky}
        aria-label="Open next 3 hours forecast" aria-haspopup="dialog" onClick={onOpen}>
        <span className="preview-heading">
          <span>Next 3 hours</span>
          <Icon name="chevron" />
        </span>
        {forecast ? <>
          <span className="preview-current">
            <span className="preview-temp" aria-label={`Current estimate ${degrees(forecast.air_temperature_c)} Celsius`}>
              {degrees(forecast.air_temperature_c)}
            </span>
            <span className="preview-condition"><Icon name={current.icon} />{current.label}</span>
          </span>
          <span className="preview-hours">
            {forecast.hourly_forecast.map((hour) => {
              const state = condition(hour.weather_code, hour.is_day);
              return <span key={hour.valid_at} title={state.label}>
                <time dateTime={hour.valid_at}>{timeLabel(hour.valid_at)}</time>
                <span className="preview-hour-value"><Icon name={state.icon} />{degrees(hour.air_temperature_c)}</span>
              </span>;
            })}
          </span>
        </> : <span className="preview-empty" role="status">{unavailable ? "Forecast unavailable" : "Loading forecast…"}</span>}
      </button>

      <dialog className="weather-dialog" ref={dialog} aria-labelledby="weather-title" data-sky={current.sky}
        data-paused={paused} onClose={() => {
          setShowReport(false);
          onClose();
          preview.current?.focus();
        }}>
        <div className="weather-scene" aria-hidden="true"><span /><span /></div>
        <div className="weather-dialog-content">
          <header className="weather-dialog-header">
            <div>
              <h2 id="weather-title">{locationName} forecast</h2>
              <p>Next 3 hours · India Standard Time</p>
            </div>
            <button type="button" className="weather-icon-button" aria-label="Close forecast"
              onClick={() => dialog.current?.close()}><Icon name="close" /></button>
          </header>
          {unavailable && <div className="weather-empty" role="status">
            <p>{unavailable}</p>
            <button type="button" onClick={() => {
              setError(null);
              setWeather(null);
              setRequest((value) => value + 1);
            }}>Retry forecast</button>
          </div>}
          {!forecast && !unavailable && <p role="status">Loading the hourly outlook…</p>}
          {forecast && <>
            <section className="weather-overview" aria-label={`Current ${locationName} weather estimate`}>
              <div className="weather-reading">
                <span className="weather-big-temp">{degrees(forecast.air_temperature_c)}</span>
                <span className="weather-condition"><Icon name={current.icon} />{current.label}</span>
                <p>Estimated at {timeLabel(forecast.valid_at)} IST</p>
              </div>
              <dl className="weather-summary">
                <div><dt>Feels like now</dt><dd>{degrees(forecast.feels_like_c)}</dd></div>
                <div><dt>Precipitation, next 3 hours</dt><dd>{forecast.upcoming_rain_mm.toFixed(1)} <small>mm</small></dd></div>
                <div><dt>Precipitation, previous 2 hours</dt><dd>{forecast.recent_rain_mm.toFixed(1)} <small>mm</small></dd></div>
              </dl>
            </section>
            <section className="weather-hourly" aria-labelledby="weather-hourly-title">
              <h3 id="weather-hourly-title">Hourly breakdown</h3>
              <table>
                <thead><tr><th scope="col">Time</th><th scope="col">Air temp.</th><th scope="col">Feels like</th>
                  <th scope="col">Precip.</th><th scope="col">Humidity</th></tr></thead>
                <tbody>{forecast.hourly_forecast.map((hour) => {
                  const state = condition(hour.weather_code, hour.is_day);
                  return <tr key={hour.valid_at}>
                    <th scope="row">
                      <time dateTime={hour.valid_at}>{timeLabel(hour.valid_at)}</time>
                      <small><Icon name={state.icon} />{state.label}</small>
                    </th>
                    <td>{hour.air_temperature_c.toFixed(1)} °C</td>
                    <td>{hour.feels_like_c.toFixed(1)} °C</td>
                    <td>{hour.precipitation_mm.toFixed(1)} mm</td>
                    <td>{Math.round(hour.relative_humidity_pct)}%</td>
                  </tr>;
                })}</tbody>
              </table>
            </section>
            <details className="weather-method">
              <summary>Forecast source and coverage</summary>
              <p>Open-Meteo model estimates for the Bengaluru grid cell at {forecast.provenance.grid_cell_center.latitude.toFixed(3)}°N, {forecast.provenance.grid_cell_center.longitude.toFixed(3)}°E.
                Air temperature is estimated at 2 m. Model resolution is unspecified.</p>
              <p>Retrieved {timeLabel(forecast.provenance.retrieved_at)} IST. Forecasts describe a city-scale grid point.
                Follow official alerts for flood and heatwave warnings.</p>
              <a href="https://open-meteo.com/">Open-Meteo</a>
            </details>
          </>}
          <div className="weather-detail-actions">
            <button type="button" aria-expanded={showReport} aria-controls="weather-two-day"
              onClick={() => setShowReport((value) => !value)}>{showReport ? "Hide two-day weather report" : "Two-day weather report"}<Icon name="chevron" /></button>
            {forecast && animated && <button type="button" className="weather-motion-toggle"
              onClick={() => setPaused((value) => !value)}>{paused ? "Resume background motion" : "Pause background motion"}</button>}
          </div>
        <div id="weather-two-day" hidden={!showReport}>{showReport && <TwoDayWeatherReport outlook={outlook} location={location} locationName={locationName} />}</div>
        </div>
      </dialog>
    </>
  );
}
