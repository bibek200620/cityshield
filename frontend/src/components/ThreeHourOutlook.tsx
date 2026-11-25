import { useEffect, useState } from "react";
import { api, type WeatherAvailabilityResponse } from "../api/client";

const bengaluruTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

export default function ThreeHourOutlook() {
  const [weather, setWeather] = useState<WeatherAvailabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getWeatherNowcast(controller.signal)
      .then(setWeather)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "The outlook could not load.");
        }
      });
    return () => controller.abort();
  }, []);

  if (error) return <p className="route-error" role="alert">{error}</p>;
  if (!weather) return <p role="status">Loading the hourly outlook…</p>;
  if (weather.status === "unavailable") {
    return <div className="outlook-unavailable" role="status">
      <strong>3-hour outlook unavailable</strong>
      <p>{weather.message}</p>
      <p>Heatwave forecast unavailable in this MVP.</p>
    </div>;
  }

  return (
    <div className="three-hour-outlook">
      <p className="outlook-source">Bengaluru city-point estimate · Open-Meteo · air temperature at 2 m</p>
      <p className="outlook-provenance">
        Automatic Best Match model; exact model version and spatial resolution are not returned. Grid cell: {weather.provenance.grid_cell_center.latitude.toFixed(3)}, {weather.provenance.grid_cell_center.longitude.toFixed(3)}. Retrieved {bengaluruTime.format(new Date(weather.provenance.retrieved_at))} IST; valid times are converted from UTC.
      </p>
      <ol className="outlook-hours" aria-label="Next three hourly weather estimates">
        {weather.hourly_forecast.map((hour, index) => (
          <li className="outlook-hour" key={hour.valid_at}>
            <div className="outlook-hour-title">
              <strong>Hour {index + 1}</strong>
              <time dateTime={hour.valid_at}>{bengaluruTime.format(new Date(hour.valid_at))} IST</time>
            </div>
            <div className="outlook-values">
              <span><strong>{hour.air_temperature_c.toFixed(1)}°</strong><small>air</small></span>
              <span><strong>{hour.feels_like_c.toFixed(1)}°</strong><small>feels like</small></span>
              <span><strong>{hour.precipitation_mm.toFixed(1)} mm</strong><small>rain</small></span>
              <span><strong>{Math.round(hour.relative_humidity_pct)}%</strong><small>humidity</small></span>
            </div>
          </li>
        ))}
      </ol>
      <p className="outlook-limits">
        Forecast-model estimates are not street-level observations. Rainfall here is not a flood warning;
        Landsat surface temperature does not provide a future heatwave forecast.
      </p>
      <p className="outlook-attribution">Weather data: <a href="https://open-meteo.com/">Open-Meteo</a></p>
    </div>
  );
}
