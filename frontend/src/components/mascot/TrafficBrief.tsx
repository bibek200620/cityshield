import { useEffect, useRef } from "react";
import type { DrivingOption, DrivingResponse } from "../../api/client";
import type { useDrivingPlanner } from "../../map/drivingPlanner";
import RoutePlaceSearch from "../RoutePlaceSearch";

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

function tripBrief(response: DrivingResponse, route: DrivingOption) {
  const spans = route.traffic_segments ?? [];
  const level = spans.some((span) => span.level === "heavy") ? "Heavy delay or a closure was reported on parts of this route."
    : spans.some((span) => span.level === "slow") ? "Slow traffic was reported on parts of this route."
      : spans.length && spans.every((span) => span.level === "clear") ? "The provider reported no delays on this route."
        : "Live traffic detail is unavailable for some or all of this route.";
  const delta = route.traffic_time_delta_seconds;
  const delay = delta && Math.round(Math.abs(delta) / 60) > 0
    ? ` About ${Math.round(Math.abs(delta) / 60)} minutes ${delta > 0 ? "above" : "below"} the provider’s no-traffic estimate.` : "";
  const traffic = level + delay;
  const weather = response.weather;
  const forecast = weather.status === "ready"
    ? `Bengaluru’s city forecast shows ${weather.upcoming_rain_mm.toFixed(1)} mm of precipitation over the next three hours.`
    : "The Bengaluru precipitation forecast is unavailable.";
  const exposure = route.runoff
    ? `Modeled runoff exposure is ${route.runoff.current_km.toFixed(2)} km with recent rain and ${route.runoff.forecast_km.toFixed(2)} km with forecast rain, across ${route.runoff.covered_km.toFixed(2)} km of screened route. The route estimate can change with traffic coverage.`
    : "Modeled runoff exposure is unavailable for this route.";
  const reports = response.flood_reports.status === "ready" && route.nearby_flood_reports !== undefined
    ? `${route.nearby_flood_reports} nearby flood ${route.nearby_flood_reports === 1 ? "report" : "reports"} in the provider feed.`
    : "The flood-incident feed is unavailable for this route.";
  return { eta: minutes(route.eta_seconds), traffic, forecast, exposure, reports };
}

export default function TrafficBrief({ drive, onRead }: {
  drive: ReturnType<typeof useDrivingPlanner>;
  onRead?: (brief: string) => void;
}) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const route = drive.result?.routes.find((option) => option.id === drive.selectedId);
  const brief = drive.result && route ? tripBrief(drive.result, { ...route, traffic_segments: drive.liveTrafficSegments ?? route.traffic_segments }) : null;
  const scenario = drive.scenarioRoutes.find((option) => option.id === route?.id);
  const scenarioSummary = scenario && scenario.covered_km > 0
    ? `In the rainfall demo, ${scenario.exposed_km.toFixed(2)} kilometres cross screened areas. The demo estimate is ${minutes(scenario.demoEtaSeconds)} minutes.`
    : "";
  const navigating = drive.navigationMode !== "idle";

  async function check() {
    const response = await drive.compare();
    const selected = response?.routes[0];
    if (mounted.current && response && selected) {
      const summary = tripBrief(response, selected);
      onRead?.(`The route estimate is ${summary.eta} minutes. ${summary.traffic} ${summary.forecast} ${summary.exposure} ${summary.reports}`);
    }
  }

  return (
    <div className="mascot-tool" aria-label="Traffic and route report">
      {navigating ? <p>Showing the selected route. Stop navigation in Car routes to change its endpoints.</p> :
        <div className="mascot-trip">
          {(["source", "destination"] as const).map((endpoint) => (
            <div key={endpoint}>
              <strong>{endpoint === "source" ? "Source" : "Destination"}</strong>
              {drive.points[endpoint] && <p>Selected: {drive.points[endpoint]?.name}</p>}
              <RoutePlaceSearch endpoint={endpoint} onSelect={(place) => drive.setPoint(endpoint, place)} />
            </div>
          ))}
          <button type="button" className="mascot-primary" disabled={!drive.points.source || !drive.points.destination || drive.loading}
            onClick={() => { void check(); }}>{drive.loading ? "Checking the route…" : "Check traffic"}</button>
        </div>}
      {drive.status && <p className="mascot-error" role="alert">{drive.status}</p>}
      {brief && route && drive.result && <section className="mascot-result" aria-label="Completed traffic report">
        <div className="mascot-result-title">
          <h3>{brief.eta} min · {route.distance_km.toFixed(1)} km</h3>
          {onRead && <button type="button" className="mascot-secondary"
            onClick={() => onRead(`The route estimate is ${brief.eta} minutes. ${brief.traffic} ${brief.forecast} ${brief.exposure} ${brief.reports} ${scenarioSummary}`)}>Read traffic</button>}
        </div>
        <p>{brief.traffic}</p>
        <p>{brief.forecast}</p>
        <p>{brief.exposure}</p>
        <p>{brief.reports}</p>
        {drive.scenario && <p>{scenarioSummary || (drive.scenarioValue ? "Route runoff screening is unavailable for this scenario." : "Screening the route against the rainfall scenario…")}</p>}
        <p>Route estimates can change with mapped road coverage and current traffic availability.</p>
      </section>}
    </div>
  );
}
