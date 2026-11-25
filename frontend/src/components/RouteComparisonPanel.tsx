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
