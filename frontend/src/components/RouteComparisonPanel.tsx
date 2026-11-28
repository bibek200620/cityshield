import { useFloodStore, type VehicleType } from "../store/useFloodStore";

const vehicles: { id: VehicleType; name: string }[] = [
  { id: "ambulance", name: "Ambulance" },
  { id: "fire", name: "Fire truck" },
  { id: "rescue", name: "Rescue vehicle" },
  { id: "police", name: "Police vehicle" },
];

export default function RouteComparisonPanel() {
  const route = useFloodStore((s) => s.route);
  const facilities = useFloodStore((s) => s.criticalInfra);
  const result = useFloodStore((s) => s.simulateResult);
  const computeRoute = useFloodStore((s) => s.computeRoute);
  const vehicle = useFloodStore((s) => s.vehicleType);
  const setVehicle = useFloodStore((s) => s.setVehicleType);
  const selected = useFloodStore((s) => s.selectedRouteId);
  const selectRoute = useFloodStore((s) => s.setSelectedRouteId);
  const loading = useFloodStore((s) => s.loading);
  const destination = facilities.find((item) => item.infra_type === "hospital") ?? facilities[0];
  const origin = result?.road_segments[0]?.geometry.coordinates[0];

  return (
    <div className="detail-content">
      <p>Compare model routes to {destination?.name ?? "a facility"} using simulated road conditions and assumed vehicle speeds. For research use only.</p>
      <label>
        Vehicle
        <select value={vehicle} onChange={(event) => setVehicle(event.target.value as VehicleType)}>
          {vehicles.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <button type="button" className="primary-button" disabled={loading || !origin || !destination}
        onClick={() => {
          if (origin && destination) {
            void computeRoute({ lng: origin[0], lat: origin[1] }, { lng: destination.lng, lat: destination.lat }, vehicle);
          }
        }}>
        Compare simulated routes
      </button>
      {route?.critical_access_risk && <p>{route.critical_access_risk.message}</p>}
      {route?.routing_context && <section className="route-conditions" aria-label="Route weather context">
        <strong>Weather used for this route check</strong>
        {route.routing_context.weather_status === "ready" ? <>
          <p>{route.routing_context.current_air_temperature_c ?? "—"} °C air temperature · feels like {route.routing_context.current_feels_like_c ?? "—"} °C · {route.routing_context.recent_rain_mm ?? "—"} mm recent rainfall.</p>
          <p>Rainfall informs the flood-state route estimate; air temperature is shown for context.</p>
          {route.routing_context.route_weather_window?.status === "ready"
            ? <p>Next {route.routing_context.route_weather_window.horizon_minutes} minutes, including a 30-minute buffer: {route.routing_context.route_weather_window.forecast_rain_mm ?? "—"} mm forecast rainfall.</p>
            : <p>The forecast did not cover the route window. Recent rainfall and the selected scenario were used without a forecast update.</p>}
          {route.routing_context.forecast_road_state_used && <p>The route search included updated flood-state estimates from this rainfall window.</p>}
          {!route.routing_context.forecast_road_state_used && route.routing_context.recent_rain_road_state_used && <p>The route search included recent-rain flood-state estimates; the forecast was not used to update the road state.</p>}
          {route.routing_context.route_weather_window?.status === "ready" && !route.routing_context.forecast_road_state_used && <p>The forecast was available but could not update the road-state estimate; the selected scenario remains in use.</p>}
        </> : <p>Current weather was unavailable; the route search used the selected rainfall scenario.</p>}
        {route.routing_context.historical_flood_context?.limitation && <p>{route.routing_context.historical_flood_context.limitation} Historical records do not change the route ranking.</p>}
      </section>}
      {route?.routes?.map((option) => (
        <button key={option.id} type="button" className="route-option"
          aria-pressed={selected === option.id} onClick={() => selectRoute(option.id)}>
          <strong>{option.id === "recommended" ? "Lowest flood penalty" : option.id === "shortest" ? "Shortest model route" : option.name}</strong>
          <span className="block">{option.eta_minutes} min · {option.distance_km} km (model estimates)</span>
        </button>
      ))}
    </div>
  );
}
