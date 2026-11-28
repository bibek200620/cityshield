import { useEffect, useRef, useState } from "react";
import { api, type LatLng, type PointForecastResponse, type WeatherAvailabilityResponse } from "../api/client";
import Icon, { type IconName } from "./Icon";
import PointForecast from "./PointForecast";
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

export default function ThreeHourOutlook({ open, onOpen, onClose, location, locationName = "India" }: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  location?: LatLng;
  locationName?: string;
}) {
  const [weather, setWeather] = useState<WeatherAvailabilityResponse | null>(null);
  const [pointForecast, setPointForecast] = useState<PointForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [request, setRequest] = useState(0);
  const [paused, setPaused] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const latitude = location?.lat;
  const longitude = location?.lng;
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setWeather(null);
    setPointForecast(null);
    setError(null);
    setLoading(true);
    api.getWeatherNowcast(controller.signal, latitude !== undefined && longitude !== undefined
      ? { lat: latitude, lng: longitude } : undefined)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        setWeather(result);
        if (result.status === "unavailable") {
          try {
            const point = { lat: latitude ?? 12.9716, lng: longitude ?? 77.5946 };
            const fallback = await api.getPointForecast(point, controller.signal);
            if (!controller.signal.aborted) setPointForecast(fallback);
          } catch {
            if (!controller.signal.aborted) {
              setError("The point forecast could not load. Check the backend forecast configuration.");
            }
          }
        }
      })
      .catch(async () => {
        if (!controller.signal.aborted) {
          try {
            const fallback = await api.getPointForecast(
              { lat: latitude ?? 12.9716, lng: longitude ?? 77.5946 }, controller.signal,
            );
            if (!controller.signal.aborted) setPointForecast(fallback);
          } catch {
            if (!controller.signal.aborted) {
              setError("The point forecast could not load. Check the backend forecast configuration.");
            }
          }
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
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
  const pointHours = Array.isArray(pointForecast?.hours) ? pointForecast.hours : [];
  const pointCurrent = pointHours[0] ?? null;
  const current = condition(forecast?.weather_code, forecast?.is_day);
  const animated = current.sky !== "neutral" && current.sky !== "night";
  const unavailable = !loading && !forecast && !pointCurrent
    ? error ?? (weather?.status === "unavailable" ? weather.message : null)
    : null;

  return (
    <>
      <button ref={preview} type="button" className="weather-preview" data-sky={current.sky}
        aria-label="Open next 3 hours forecast" aria-haspopup="dialog" onClick={onOpen}>
        <span className="preview-heading">
          <span><span>Next 3 hours</span><small>{locationName}</small></span>
          <Icon name="chevron" />
        </span>
        {forecast ? <>
          {forecast.is_stale && <span className="forecast-stale-note" role="status">
            Cached estimate · last updated {Math.max(1, Math.round((forecast.stale_age_seconds ?? 60) / 60))} min ago
          </span>}
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
        </> : pointCurrent ? <>
          <span className="preview-condition">Point forecast</span>
          <span className="preview-current">
            <span className="preview-temp" aria-label={`Forecast ${degrees(pointCurrent.air_temperature_c)} Celsius`}>
              {degrees(pointCurrent.air_temperature_c)}
            </span>
            <span className="preview-condition">Air temperature</span>
          </span>
          <span className="preview-hours">
            {pointHours.slice(0, 3).map((hour) => <span key={hour.valid_at}>
              <time dateTime={hour.valid_at}>{timeLabel(hour.valid_at)}</time>
              <span className="preview-hour-value">{degrees(hour.air_temperature_c)}</span>
            </span>)}
          </span>
        </> : <span className="preview-empty" role="status">
          {unavailable ? <><span>Forecast unavailable</span><small>{unavailable}</small></> : "Loading forecast…"}
        </span>}
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
              setPointForecast(null);
              setRequest((value) => value + 1);
            }}>Retry forecast</button>
          </div>}
          {!forecast && !pointCurrent && !unavailable && <p role="status">Loading the hourly outlook…</p>}
          {pointForecast && pointCurrent && !forecast && <>
            <section className="weather-overview" aria-label={`${locationName} point forecast`}>
              <div className="weather-reading">
                <span className="weather-big-temp">{degrees(pointCurrent.air_temperature_c)}</span>
                <span className="weather-condition"><Icon name="thermometer" />Air temperature forecast</span>
                <p>Point forecast · {timeLabel(pointCurrent.valid_at)} IST</p>
              </div>
              <dl className="weather-summary">
                <div><dt>Feels like</dt><dd>{degrees(pointCurrent.feels_like_c)}</dd></div>
                <div><dt>Precipitation</dt><dd>{pointCurrent.precipitation_mm.toFixed(1)} <small>mm</small></dd></div>
                <div><dt>Relative humidity</dt><dd>{pointCurrent.relative_humidity_pct === null
                  ? "Unavailable" : `${Math.round(pointCurrent.relative_humidity_pct)}%`}</dd></div>
              </dl>
            </section>
            <section className="weather-hourly" aria-labelledby="point-forecast-hourly-title">
              <h3 id="point-forecast-hourly-title">Next forecast hours</h3>
              <table>
                <thead><tr><th scope="col">Time</th><th scope="col">Air temp.</th><th scope="col">Feels like</th>
                  <th scope="col">Precip.</th><th scope="col">Humidity</th></tr></thead>
                <tbody>{pointHours.slice(0, 3).map((hour) => <tr key={hour.valid_at}>
                  <th scope="row"><time dateTime={hour.valid_at}>{timeLabel(hour.valid_at)}</time></th>
                  <td>{hour.air_temperature_c.toFixed(1)} °C</td>
                  <td>{hour.feels_like_c.toFixed(1)} °C</td>
                  <td>{hour.precipitation_mm.toFixed(1)} mm</td>
                  <td>{hour.relative_humidity_pct === null ? "—" : `${Math.round(hour.relative_humidity_pct)}%`}</td>
                </tr>)}</tbody>
              </table>
            </section>
            <details className="weather-method" open>
              <summary>Forecast source and limits</summary>
              <p>Point forecast for {locationName} near {pointForecast.location.latitude.toFixed(3)}°N, {pointForecast.location.longitude.toFixed(3)}°E.
                This is forecast air temperature, not satellite land-surface temperature and not an official warning.</p>
              <p>Retrieved {timeLabel(pointForecast.retrieved_at)} IST{pointForecast.model_run ? ` · model run ${timeLabel(pointForecast.model_run)} IST` : ""}.</p>
            </details>
          </>}
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
              <p>Model-based weather estimates for {locationName} near {forecast.provenance.grid_cell_center.latitude.toFixed(3)}°N, {forecast.provenance.grid_cell_center.longitude.toFixed(3)}°E.
                Air temperature is estimated at 2 m. Model resolution is unspecified.</p>
              <p>Retrieved {timeLabel(forecast.provenance.retrieved_at)} IST. Forecasts describe a city-scale grid point.
                Follow official alerts for flood and heatwave warnings.</p>
            </details>
          </>}
          {location && <PointForecast location={location} locationName={locationName} />}
          <div className="weather-detail-actions">
            <button type="button" aria-expanded={showReport} aria-controls="weather-two-day"
              onClick={() => setShowReport((value) => !value)}>{showReport ? "Hide two-day weather report" : "Two-day weather report"}<Icon name="chevron" /></button>
            {forecast && animated && <button type="button" className="weather-motion-toggle"
              onClick={() => setPaused((value) => !value)}>{paused ? "Resume background motion" : "Pause background motion"}</button>}
          </div>
        <div id="weather-two-day" hidden={!showReport}>{showReport && <TwoDayWeatherReport location={location} locationName={locationName} />}</div>
        </div>
      </dialog>
    </>
  );
}
