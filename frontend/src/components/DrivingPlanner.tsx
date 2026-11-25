import { useState } from "react";
import RoutePlaceSearch from "./RoutePlaceSearch";
import type { Endpoint, useDrivingPlanner } from "../map/drivingPlanner";

const timeInBengaluru = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
});

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
      if (!(12.82 <= lat && lat <= 13.16 && 77.44 <= lng && lng <= 77.80)) {
        setGpsStatus("Your current location is outside the supported Greater Bengaluru route area.");
        return;
      }
      drive.setPoint("source", { lat, lng, name: "My current location" });
      setGpsStatus("Current location set as the route start. Use the map location control to keep tracking GPS.");
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
            <p>{weather.recent_rain_mm} mm over two model hours ending {timeInBengaluru.format(new Date(weather.recent_through))} IST. {weather.upcoming_rain_mm} mm for the following three model hours.</p>
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
        {drive.previewMode === "idle" ? <button type="button" className="primary-button"
          onClick={drive.startPreview} disabled={!drive.result.routes.some((option) => option.id === drive.selectedId)}>
          Start driving
        </button> : <div className="drive-preview-controls" role="status">
          <p><strong>{drive.previewMode === "complete" ? "Preview complete" : drive.previewMode === "paused" ? "Preview paused" : "3D route preview"}</strong>
            {drive.previewMode !== "complete" && ` · ${Math.round(drive.previewProgress * 100)}%`}</p>
          <p>Vehicle movement is simulated along the selected route. This is not live vehicle tracking or turn-by-turn navigation.</p>
          <div>
            {drive.previewMode === "running" && <button type="button" className="pick-button" onClick={drive.pausePreview}>Pause</button>}
            {drive.previewMode === "paused" && <button type="button" className="pick-button" onClick={drive.resumePreview}>Resume</button>}
            <button type="button" className="pick-button" onClick={drive.endPreview}>End preview</button>
          </div>
        </div>}
      </div>}
    </div>
  );
}
