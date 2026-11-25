import PlaceSearch from "./PlaceSearch";
import type { Endpoint, useDrivingPlanner } from "../map/drivingPlanner";

const timeInBengaluru = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
});

export default function DrivingPlanner({ drive, onPick }: {
  drive: ReturnType<typeof useDrivingPlanner>;
  onPick: (endpoint: Endpoint) => void;
}) {
  const weather = drive.result?.weather;
  return (
    <div className="driving-planner">
      {(["source", "destination"] as const).map((endpoint, index) => {
        const title = endpoint === "source" ? "Source" : "Destination";
        const point = drive.points[endpoint];
        return (
          <section key={endpoint} className="drive-endpoint" aria-label={title}>
            <h3><i aria-hidden="true">{index === 0 ? "A" : "B"}</i>{title}</h3>
            <PlaceSearch selected={null} label={`Search ${endpoint}`}
              placeholder={`Type a Bengaluru ward`}
              onSelect={(place) => drive.setPoint(endpoint, { lng: place.center[0], lat: place.center[1], name: place.name })} />
            <button type="button" className="pick-button" onClick={() => onPick(endpoint)}>
              Pick {endpoint} on map
            </button>
            {point && <div className="chosen-point">
              <span>{point.name}</span>
              <button type="button" onClick={() => drive.setPoint(endpoint, null)} aria-label={`Clear ${endpoint}`}>×</button>
            </div>}
          </section>
        );
      })}
      <button type="button" className="primary-button" disabled={!drive.points.source || !drive.points.destination || drive.loading}
        onClick={() => void drive.compare()}>{drive.loading ? "Finding routes…" : "Compare car routes"}</button>
      <p className="route-credit">Comparing sends both points to the routing provider. <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">OpenStreetMap fallback data</a>.</p>
      {drive.status && <p className="route-error" role="alert">{drive.status}</p>}
      {drive.result && <div className="route-options" aria-label="Route options">
        <div className="route-conditions" aria-label="Trip conditions">
          <strong>Trip conditions</strong>
          <p>{drive.result.traffic.message} · {drive.result.source}</p>
          {weather?.status === "ready" ? <>
            <p>{weather.air_temperature_c} °C air · feels like {weather.feels_like_c} °C · {timeInBengaluru.format(new Date(weather.valid_at))} IST</p>
            <p>{weather.recent_rain_mm} mm over two model hours ending {timeInBengaluru.format(new Date(weather.recent_through))} IST. {weather.upcoming_rain_mm} mm for the following two model hours.</p>
            <p>City weather estimate by <a href="https://open-meteo.com/">Open-Meteo</a>.</p>
          </> : <p>{weather?.message ?? "Weather data unavailable."}</p>}
          {drive.result.flood_reports.status === "unavailable" && <p>Current road flood reports unavailable.</p>}
          <p>Runoff is a model screen. Travel time estimates cover provider traffic inputs. Heat and modeled runoff are shown separately from travel times.</p>
        </div>
        {!drive.result.shortest_available && <p role="status">Distance-based comparison is temporarily unavailable.</p>}
        {drive.result.routes.map((option) => (
          <button type="button" className="route-option" key={option.id}
            aria-pressed={drive.selectedId === option.id} onClick={() => drive.setSelectedId(option.id)}>
            <strong>{option.labels.join(" · ")}</strong>
            <span className="block">{Math.max(1, Math.round(option.eta_seconds / 60))} min · {option.distance_km.toFixed(1)} km</span>
            {option.traffic_time_delta_seconds != null && <span className="block route-detail">
              {Math.round(Math.abs(option.traffic_time_delta_seconds) / 60)} min {option.traffic_time_delta_seconds < 0 ? "below" : "above"} the provider’s no-traffic estimate
            </span>}
            {option.nearby_flood_reports != null && <span className="block route-detail">
              {option.nearby_flood_reports} nearby flood reports from {drive.result?.flood_reports.source}
            </span>}
            {option.runoff && <span className="block route-detail">
              Screened runoff: {option.runoff.current_km.toFixed(2)} km recent · {option.runoff.forecast_km.toFixed(2)} km with upcoming rain
              <span className="block">{option.runoff.covered_km.toFixed(2)} km within the model grid</span>
            </span>}
          </button>
        ))}
      </div>}
    </div>
  );
}
