import { useState } from "react";
import RoutePlaceSearch from "./RoutePlaceSearch";
import { NAVIGATION_AREA, type Endpoint, useDrivingPlanner } from "../map/drivingPlanner";
import Icon from "./Icon";

const timeInBengaluru = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
});

function distanceText(metres: number): string {
  return metres >= 1_000 ? `${(metres / 1_000).toFixed(1)} km` : `${Math.max(0, Math.round(metres))} m`;
}

export default function DrivingPlanner({ drive, onPick }: {
  drive: ReturnType<typeof useDrivingPlanner>;
  onPick: (endpoint: Endpoint) => void;
}) {
  const weather = drive.result?.weather;
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);

  function useMyLocation() {
    if (!navigator.geolocation) {
      setGpsStatus("This browser does not provide GPS location.");
      return;
    }
    setGpsStatus("Requesting your location…");
    navigator.geolocation.getCurrentPosition((position) => {
      const { latitude: lat, longitude: lng } = position.coords;
      if (!(NAVIGATION_AREA.south <= lat && lat <= NAVIGATION_AREA.north
        && NAVIGATION_AREA.west <= lng && lng <= NAVIGATION_AREA.east)) {
        setGpsStatus("Your current location is outside the supported Bengaluru map area.");
        return;
      }
      drive.setPoint("source", { lat, lng, name: "My current location" });
      setGpsStatus("Current location set as the route start. Start navigation to follow live GPS.");
    }, (error) => {
      setGpsStatus(error.code === error.PERMISSION_DENIED
        ? "Location access was denied. Allow it in your browser settings and try again."
        : error.code === error.TIMEOUT
          ? "Location request timed out. Try again with GPS enabled."
          : "Current location is unavailable. Try again outdoors or use map selection.");
    }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
  }

  return (
    <div className="driving-planner">
      {(["source", "destination"] as const).map((endpoint, index) => {
        const title = endpoint === "source" ? "Source" : "Destination";
        const point = drive.points[endpoint];
        return (
          <section key={endpoint} className="drive-endpoint" aria-label={title}>
            <h3><i aria-hidden="true">{index === 0 ? "A" : "B"}</i>{title}</h3>
            <RoutePlaceSearch endpoint={endpoint}
              onSelect={(place) => drive.setPoint(endpoint, { lng: place.lng, lat: place.lat, name: place.name })} />
            {endpoint === "source" && <>
              <button type="button" className="pick-button" onClick={useMyLocation}>Use my current location</button>
              {gpsStatus && <p className="route-detail" role="status">{gpsStatus}</p>}
            </>}
            <button type="button" className="pick-button" onClick={() => onPick(endpoint)}>
              Pick {endpoint} on map
            </button>
            {point && <div className="chosen-point">
              <span>{point.name}</span>
              <button type="button" onClick={() => drive.setPoint(endpoint, null)} aria-label={`Clear ${endpoint}`}>
                <Icon name="close" />
              </button>
            </div>}
          </section>
        );
      })}
      <button type="button" className="primary-button" disabled={!drive.points.source || !drive.points.destination || drive.loading}
        onClick={() => void drive.compare()}>{drive.loading ? "Finding routes…" : "Compare car routes"}</button>
      <p className="route-credit">Place suggestions use <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>. Comparing sends both points to the routing provider.</p>
      {drive.status && <p className="route-error" role="alert">{drive.status}</p>}
      {drive.result && drive.navigationMode === "idle" && <div className="route-options" aria-label="Route options">
        <div className="route-conditions" aria-label="Trip conditions">
          <strong>Trip conditions</strong>
          <p>{drive.result.traffic.message} · {drive.result.source}</p>
          {weather?.status === "ready" ? <>
            <p>{weather.air_temperature_c} °C air · feels like {weather.feels_like_c} °C · {timeInBengaluru.format(new Date(weather.valid_at))} IST</p>
            <p>{weather.recent_rain_mm} mm over two model hours ending {timeInBengaluru.format(new Date(weather.recent_through))} IST. {weather.upcoming_rain_mm} mm for the following three model hours.</p>
            <p>City weather estimate by <a href="https://open-meteo.com/">Open-Meteo</a>.</p>
          </> : <p>{weather?.message ?? "Weather data unavailable."}</p>}
          {drive.result.flood_reports.status === "unavailable" && <p>Current road flood reports unavailable.</p>}
          <p>CityShield favors candidate routes with fewer nearby flood reports and materially less modeled runoff where coverage is comparable. Provider traffic estimates determine travel times when available.</p>
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
        <button type="button" className="primary-button"
          onClick={drive.startNavigation} disabled={!drive.result.routes.some((option) => option.id === drive.selectedId)}>
          Start navigation
        </button>
      </div>}
      {drive.navigationMode !== "idle" && <section className="live-navigation" aria-label="Live GPS navigation">
        <div className="live-navigation-heading">
          <div><strong>{drive.navigationMode === "active" ? "Navigation" : drive.navigationMode === "error" ? "Navigation unavailable" : "Starting navigation"}</strong>
            <span>{drive.navigationMode === "active" ? "Following live GPS" : drive.navigationMode === "rerouting" ? "Recalculating route" : drive.navigationMode === "routing" ? "Finding route from your location" : drive.navigationMode === "locating" ? "Waiting for GPS" : "Check location permission and retry"}</span>
          </div>
          {drive.navigationMode !== "error" && <button type="button" className="pick-button" onClick={drive.stopNavigation}>Stop</button>}
          {drive.navigationMode === "error" && <button type="button" className="pick-button" onClick={drive.stopNavigation}>Close</button>}
        </div>
        {drive.navigationLocation && <div className="live-navigation-metrics">
          {drive.routeMatch && <div><strong>{distanceText(drive.routeMatch.remaining_m)}</strong><small>remaining</small></div>}
          {drive.routeMatch && drive.result && (() => {
            const route = drive.result.routes.find((option) => option.id === drive.selectedId);
            const remainingRatio = drive.routeMatch.remaining_m / Math.max(1, (route?.distance_km ?? 0) * 1_000);
            return <div><strong>{Math.max(1, Math.round((route?.eta_seconds ?? 0) * remainingRatio / 60))} min</strong><small>estimated</small></div>;
          })()}
          <div><strong>±{Math.round(drive.navigationLocation.accuracy_m)} m</strong><small>GPS accuracy</small></div>
          {drive.navigationLocation.speed_mps !== null && <div><strong>{Math.round(drive.navigationLocation.speed_mps * 3.6)} km/h</strong><small>GPS speed</small></div>}
        </div>}
        {drive.navigationNotice && <p className="navigation-notice" role="status">{drive.navigationNotice}</p>}
        {drive.offRoute && drive.navigationMode === "active" && <div className="navigation-off-route">
          <span>You're off the selected route.</span>
          <button type="button" className="pick-button" onClick={drive.recalculateNavigation}>Recalculate route</button>
        </div>}
        <p className="navigation-limits">The map follows your device GPS. Flood-aware route selection uses available reports and modeled exposure. Follow official closures and warnings.</p>
      </section>}
    </div>
  );
}
