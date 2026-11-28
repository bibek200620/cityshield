import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, type LatLng, type PointAirQualityResponse, type PointForecastResponse } from "../api/client";

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-IN", {
    dateStyle: "short", timeStyle: "short", timeZone: "Asia/Kolkata",
  }).format(date);
}

export default function PointForecast({ location, locationName }: {
  location: LatLng;
  locationName: string;
}) {
  const [forecast, setForecast] = useState<PointForecastResponse | null>(null);
  const [airQuality, setAirQuality] = useState<PointAirQualityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(false);

  async function loadForecast() {
    setLoading(true);
    setError(null);
    try {
      const [weatherResult, airResult] = await Promise.allSettled([
        api.getPointForecast(location), api.getPointAirQuality(location),
      ]);
      if (weatherResult.status === "rejected") throw weatherResult.reason;
      setForecast(weatherResult.value);
      setAirQuality(airResult.status === "fulfilled" ? airResult.value : {
        status: "unavailable", message: "Air-quality details could not load for this location.",
      });
    } catch {
      setError("The point forecast could not load.");
    } finally {
      setLoading(false);
    }
  }

  return <section className="point-forecast" aria-labelledby="point-forecast-title">
    <h3 id="point-forecast-title">Detailed point forecast</h3>
    <p>Hourly point forecast for {locationName}.</p>
    {!forecast && <button type="button" onClick={() => void loadForecast()} disabled={loading}>
      {loading ? "Loading forecast…" : "Load point forecast"}
    </button>}
    {error && <p role="status">{error} Check the backend forecast configuration.</p>}
    {forecast && <>
      <p>Retrieved {displayTime(forecast.retrieved_at)} IST
        {forecast.model_run ? ` · model run ${displayTime(forecast.model_run)}` : ""}</p>
      {forecast.current && <dl className="point-current-conditions">
        <div><dt>Current air temperature</dt><dd>{forecast.current.air_temperature_c?.toFixed(1) ?? "Unavailable"} °C</dd></div>
        <div><dt>Feels like</dt><dd>{forecast.current.feels_like_c?.toFixed(1) ?? "Unavailable"} °C</dd></div>
        <div><dt>Heat index</dt><dd>{forecast.current.heat_index_c?.toFixed(1) ?? "Unavailable"} °C</dd></div>
        <div><dt>Humidity</dt><dd>{forecast.current.relative_humidity_pct === null ? "Unavailable" : `${Math.round(forecast.current.relative_humidity_pct)}%`}</dd></div>
        <div><dt>Wind speed</dt><dd>{forecast.current.wind_speed_kmh?.toFixed(1) ?? "Unavailable"} km/h</dd></div>
        <div><dt>UV index</dt><dd>{forecast.current.uv_index ?? "Unavailable"}</dd></div>
        <div><dt>Rain in latest hour</dt><dd>{forecast.current.precipitation_1h_mm?.toFixed(1) ?? "Unavailable"} mm</dd></div>
        <div><dt>Conditions</dt><dd>{forecast.current.condition ?? "Unavailable"}</dd></div>
      </dl>}
      <p>Wet-bulb temperature (forecast): {forecast.hours[0]?.wet_bulb_c?.toFixed(1) ?? "Unavailable"} °C. WBGT is not calculated; it needs additional radiant-heat inputs and a validated method.</p>
      <section className="point-air-quality" aria-label="Air quality">
        <h4>Air quality</h4>
        {!airQuality && <p>Loading air-quality details…</p>}
        {airQuality?.status === "unavailable" && <p role="status">{airQuality.message}</p>}
        {airQuality && airQuality.status !== "unavailable" && (airQuality.indexes.length
          ? <ul>{airQuality.indexes.map((index) => <li key={index.name}>
            <strong>{index.name}: {index.value}</strong> · {index.category}
            {index.dominant_pollutant && ` · Main pollutant: ${index.dominant_pollutant}`}
          </li>)}</ul>
          : <p>No air-quality index is available for this point.</p>)}
        {airQuality && airQuality.status !== "unavailable" && airQuality.pollutants.length > 0 ? <ul className="point-pollutants">
          {airQuality.pollutants.map((pollutant) => <li key={pollutant.name}>
            {pollutant.name}: {pollutant.value ?? "Unavailable"} {pollutant.unit ?? ""}
          </li>)}
        </ul> : null}
        {airQuality && airQuality.status !== "unavailable" && airQuality.limitations.map((limitation) => <p className="coverage-note" key={limitation}>{limitation}</p>)}
      </section>
      <div className="weather-hourly">
        <table>
          <thead><tr><th scope="col">Time</th><th scope="col">Air temp.</th><th scope="col">Feels like</th>
            <th scope="col">Precip.</th><th scope="col">Humidity</th></tr></thead>
          <tbody>{forecast.hours.slice(0, 24).map((hour) => <tr key={hour.valid_at}>
            <th scope="row"><time dateTime={hour.valid_at}>{displayTime(hour.valid_at)}</time></th>
            <td>{hour.air_temperature_c.toFixed(1)} °C</td>
            <td>{hour.feels_like_c.toFixed(1)} °C</td>
            <td>{hour.precipitation_mm.toFixed(1)} mm</td>
            <td>{hour.relative_humidity_pct === null ? "Unavailable" : `${Math.round(hour.relative_humidity_pct)}%`}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p>Location-based point forecast for the selected coordinates. Values can differ from national grid estimates and are not an official warning.</p>
      {forecast.limitations?.map((limitation) => <p className="coverage-note" key={limitation}>{limitation}</p>)}
      <button type="button" onClick={() => {
        setShowChart((shown) => !shown);
      }}>
        {showChart ? "Hide 5-day chart" : "Show 5-day chart"}
      </button>
      {showChart && forecast.hours.length > 0 && <div className="point-forecast-chart" role="img"
        aria-label={`Five-day air-temperature forecast chart for ${locationName}`}>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={forecast.hours.slice(0, 120)} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="valid_at" tickFormatter={(value: string) => new Intl.DateTimeFormat("en-IN", {
              day: "numeric", hour: "numeric", timeZone: "Asia/Kolkata",
            }).format(new Date(value))} minTickGap={48} />
            <YAxis unit="°C" width={48} />
            <Tooltip labelFormatter={(value) => displayTime(String(value))}
              formatter={(value) => [`${Number(value).toFixed(1)} °C`, "Air temperature"]} />
            <Line type="monotone" dataKey="air_temperature_c" stroke="#c46735" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
        {forecast.hours.length < 120 && <p role="status">Only {forecast.hours.length} hourly values are available; the chart shows the available forecast period.</p>}
      </div>}
    </>}
  </section>;
}
