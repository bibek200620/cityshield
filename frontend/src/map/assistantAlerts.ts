import type { AssistantAlertKind, AssistantOutlook, DrivingOption, DrivingResponse } from "../api/client";
import type { LiveLocation, RouteMatch } from "./drivingPlanner";

export type FaceFamily = "happy" | "bright" | "watchful" | "rain" | "flood" | "traffic" | "urgent";

export interface MascotAlert {
  kind: AssistantAlertKind | "scenario_flood" | "scenario_route" | "heat";
  face: FaceFamily;
  title: string;
  message: string;
  key?: string;
}

const minute = 60_000;
const isAhead = (until: string, now: number) => Date.parse(until) > now;

function isRecent(timestamp: string | undefined, now: number, limit: number) {
  if (!timestamp) return false;
  const elapsed = now - Date.parse(timestamp);
  return elapsed >= -minute && elapsed <= limit;
}

function distanceLabel(metres: number) {
  if (metres < 100) return "on this stretch";
  if (metres < 1000) return `about ${Math.round(metres / 100) * 100} metres ahead`;
  return `about ${(metres / 1000).toFixed(1)} kilometres ahead`;
}

export function collectMascotAlerts(
  outlook: AssistantOutlook | null, now: number,
  trip?: { response: DrivingResponse; route: DrivingOption; distances: number[]; match: RouteMatch; location: LiveLocation },
): MascotAlert[] {
  const alerts: MascotAlert[] = [];
  if (trip && trip.match.distance_from_route_m <= Math.max(90, trip.location.accuracy_m * 1.5)
    && now - trip.location.timestamp <= 30_000) {
    const { response, route, match, location, distances } = trip;
    const speed = Math.max(5, location.speed_mps ?? route.distance_km * 1000 / Math.max(1, route.eta_seconds));
    const routeMetres = distances[distances.length - 1];
    const rainLead = Math.min(4500, Math.max(900, speed * 480));
    const weather = response.weather;
    if (weather.status === "ready" && isAhead(weather.forecast_through, now)
        && isRecent(weather.provenance.retrieved_at, now, 30 * minute)) {
      const span = route.forecast_runoff_spans?.find(({ start, end }) =>
        end > match.progress && (start - match.progress) * routeMetres <= rainLead,
      );
      if (span) {
        const distance = Math.max(0, (span.start - match.progress) * routeMetres);
        alerts.push({
          kind: "route_rain",
          face: "rain",
          title: "Possible flood risk on this route",
          message: `Rain is forecast, and the route crosses a modeled runoff area ${distanceLabel(distance)}. Consider a different route when you can safely check.`,
        });
      }
    }

    const trafficLead = Math.min(2200, Math.max(500, speed * 120));
    if (response.traffic.status === "ready" && isRecent(response.traffic.checked_at, now, 10 * minute)) {
      const span = route.traffic_segments?.find(({ start_index, end_index, level }) =>
        (level === "slow" || level === "heavy") &&
          distances[end_index] > match.progress_m && distances[start_index] - match.progress_m <= trafficLead,
      );
      if (span) {
        const distance = Math.max(0, distances[span.start_index] - match.progress_m);
        const heavy = span.level === "heavy";
        alerts.push({
          kind: "traffic",
          face: heavy ? "urgent" : "traffic",
          title: heavy ? "Heavy delay ahead" : "Slow traffic ahead",
          message: `Traffic data shows ${heavy ? "a heavy delay or possible closure" : "slow traffic"} ${distanceLabel(distance)}.`,
        });
      }
    }
  }

  if (outlook?.status === "ready" && outlook.alert && isAhead(outlook.forecast_through, now)
      && isRecent(outlook.checked_at, now, 12 * minute)) {
    alerts.push({
      kind: "city_flood",
      face: "flood",
      title: "Flood risk in the next 3 hours",
      message: `The forecast triggers the CityShield flood screen in ${outlook.alert.cells} Bengaluru grid cells. Check official alerts.`,
    });
  }
  if (outlook?.status === "ready" && outlook.heat && isAhead(outlook.forecast_through, now)
      && isRecent(outlook.checked_at, now, 12 * minute)) {
    alerts.push({
      kind: "heat", face: "watchful", title: "Elevated feels-like heat",
      message: `The Bengaluru model reaches ${Math.round(outlook.heat.feels_like_c)} degrees feels like, above the CityShield heat screening threshold. Check the local heat advisory.`,
    });
  }
  return alerts;
}

export function scenarioRouteAlert(spans: { start: number; end: number }[], match: RouteMatch, revision: number): MascotAlert | null {
  const total = match.progress_m + match.remaining_m;
  const span = spans.find(({ start, end }) => end > match.progress && start * total - match.progress_m <= 1400);
  if (!span) return null;
  const distance = Math.max(0, span.start * total - match.progress_m);
  return {
    kind: "scenario_route", face: "rain", key: `scenario-route:${revision}`,
    title: "Simulated flood exposure ahead",
    message: `In this demo, the route crosses a runoff area ${distanceLabel(distance)}. Check the other routes for lower scenario exposure.`,
  };
}
