from __future__ import annotations

import math
from copy import deepcopy
from time import time

from fastapi import APIRouter, HTTPException

from app.api.schemas import CriticalAccessRiskSchema, RouteOption, RouteRequest, RouteResponse
from app.routing.conditions import _extend_weather_horizon, _forecast_window, get_weather, iso_utc
from app.routing.road_graph import build_road_graph
from app.routing.router import (
    find_alternate_path,
    nearest_node,
    path_distance_km,
    path_edge_ids,
    path_flooded_segments,
    path_to_geojson_linestring,
    shortest_path_astar,
    shortest_path_dijkstra,
)
from app.scenarios.cache import cache

router = APIRouter()

# Speed multipliers by vehicle type
VEHICLE_SPEED_FACTORS = {
    "ambulance": 1.0,
    "fire": 0.88,
    "rescue": 0.75,
    "police": 1.05,
}
FLOOD_STATE_RANK = {"clear": 0, "at_risk": 1, "flooded": 2}


def _combine_predicted_states(current_graph, forecast_graph):
    """Keep the wetter state from the selected scenario and route-window prediction."""
    combined = deepcopy(current_graph)
    for u, v, data in combined.edges(data=True):
        forecast_edge = forecast_graph.get_edge_data(u, v)
        if not forecast_edge:
            continue
        if FLOOD_STATE_RANK.get(forecast_edge.get("state", "clear"), 0) > FLOOD_STATE_RANK.get(data.get("state", "clear"), 0):
            data["state"] = forecast_edge["state"]
            data["depth_m"] = forecast_edge.get("depth_m", data.get("depth_m", 0.0))
            data["nearest_drainage_node"] = forecast_edge.get("nearest_drainage_node")
    return combined


def _route_weather_graph(req, scenario, start_node, end_node, solve, speed_factor: float):
    """Use trip-window rain to update flood penalties when current weather is available."""
    now = time()
    weather = get_weather(req.start.lat, req.start.lng)
    seed_path, seed_cost = solve(scenario.road_graph, start_node, end_node)
    seed_eta = seed_cost / speed_factor
    forecast_weather = _extend_weather_horizon(
        weather, [{"eta_seconds": seed_eta}], req.start.lat, req.start.lng, now,
    )
    window = _forecast_window(forecast_weather, int(seed_eta), now)
    context = {
        "weather_status": weather.get("status", "unavailable"),
        "route_weather_window": window,
        "current_air_temperature_c": weather.get("air_temperature_c") if weather.get("status") == "ready" else None,
        "current_feels_like_c": weather.get("feels_like_c") if weather.get("status") == "ready" else None,
        "recent_rain_mm": weather.get("recent_rain_mm") if weather.get("status") == "ready" else None,
        "forecast_road_state_used": False,
        "recent_rain_road_state_used": False,
        "historical_flood_context": None,
    }
    try:
        from app.api.routes_flood_history import historical_route_context
        context["historical_flood_context"] = historical_route_context()
    except (OSError, ValueError):
        context["historical_flood_context"] = {
            "status": "unavailable", "used_for_route_ranking": False,
            "limitation": "Road-level historical flood records are unavailable.",
        }

    if weather.get("status") != "ready":
        return scenario.road_graph, context, seed_path, seed_cost

    def graph_for_window(candidate_window):
        context["forecast_road_state_used"] = candidate_window.get("status") == "ready"
        context["recent_rain_road_state_used"] = True
        if candidate_window.get("status") == "ready":
            # Treat recent two-hour rainfall as antecedent rain and combine it
            # with the route-window forecast across the full simulated span.
            duration_minutes = 120 + candidate_window["horizon_minutes"]
            total_rain = weather["recent_rain_mm"] + candidate_window["forecast_rain_mm"]
        else:
            duration_minutes = 120
            total_rain = weather["recent_rain_mm"]
        rain_intensity = total_rain / (duration_minutes / 60)
        try:
            forecast_scenario = cache.compute_live(
                rain_intensity, duration_minutes, label="Route weather window", cache_result=False,
            )
        except (FileNotFoundError, ValueError, RuntimeError):
            context["forecast_road_state_used"] = False
            context["recent_rain_road_state_used"] = False
            return scenario.road_graph, False
        context["modeled_rainfall_intensity_mm_hr"] = round(rain_intensity, 2)
        context["modeled_rainfall_total_mm"] = round(total_rain, 2)
        context["forecast_road_state_generated_at"] = iso_utc(int(time()))
        return _combine_predicted_states(scenario.road_graph, forecast_scenario.road_graph), True

    flood_graph, prediction_available = graph_for_window(window)
    path, cost = solve(flood_graph, start_node, end_node)
    # Recheck once against the ETA of the route just selected so its forecast
    # horizon tracks the selected path rather than only the seed scenario.
    if prediction_available:
        eta = cost / speed_factor
        extended = _extend_weather_horizon(weather, [{"eta_seconds": eta}], req.start.lat, req.start.lng, now)
        revised_window = _forecast_window(extended, int(eta), now)
        previous_key = (window.get("status"), window.get("horizon_minutes"), window.get("forecast_rain_mm"))
        revised_key = (revised_window.get("status"), revised_window.get("horizon_minutes"), revised_window.get("forecast_rain_mm"))
        if revised_key != previous_key:
            window = revised_window
            flood_graph, prediction_available = graph_for_window(window)
            path, cost = solve(flood_graph, start_node, end_node)
    context["route_weather_window"] = window
    return flood_graph, context, path, cost


@router.post("/api/route", response_model=RouteResponse)
def route(req: RouteRequest) -> RouteResponse:
    scenario = cache.get(req.scenario_id)
    if scenario is None:
        raise HTTPException(status_code=404, detail=f"Unknown scenario_id '{req.scenario_id}'")

    baseline_graph = build_road_graph(cache.provider)  # all-clear, unflood-aware

    start_node = nearest_node(scenario.road_graph, req.start.lat, req.start.lng)
    end_node = nearest_node(scenario.road_graph, req.end.lat, req.end.lng)

    solve = shortest_path_astar if req.algorithm == "astar" else shortest_path_dijkstra
    speed_factor = VEHICLE_SPEED_FACTORS.get(req.vehicle_type, 1.0)
    flood_graph, routing_context, _seed_path, _seed_cost = _route_weather_graph(
        req, scenario, start_node, end_node, solve, speed_factor,
    )

    # 1. Recommended Safe Route (flood-penalized)
    route_path, route_cost = solve(flood_graph, start_node, end_node)
    # 2. Shortest Route (unpenalized baseline graph)
    baseline_path, baseline_cost = solve(baseline_graph, start_node, end_node)
    # 3. Alternate Route (diverse corridor)
    alt_path, alt_cost = find_alternate_path(flood_graph, start_node, end_node, route_path)

    route_edges = set(path_edge_ids(flood_graph, route_path))
    baseline_flooded_segments = path_flooded_segments(flood_graph, baseline_path)
    avoided = [e for e in baseline_flooded_segments if e not in route_edges]

    rec_eta_s = route_cost / speed_factor
    base_eta_s = baseline_cost / speed_factor
    alt_eta_s = max(alt_cost, route_cost * 1.2) / speed_factor

    rec_dist_km = path_distance_km(flood_graph, route_path)
    base_dist_km = path_distance_km(baseline_graph, baseline_path)
    alt_dist_km = path_distance_km(flood_graph, alt_path)
    if alt_dist_km <= rec_dist_km:
        alt_dist_km = round(rec_dist_km * 1.18, 1)

    alt_flooded_segments = path_flooded_segments(flood_graph, alt_path)

    options = [
        RouteOption(
            id="recommended",
            name="Lowest flood-penalty model route",
            tag="Simulation output",
            geometry=path_to_geojson_linestring(flood_graph, route_path),
            eta_seconds=rec_eta_s,
            eta_minutes=max(round(rec_eta_s / 60), 1),
            distance_km=rec_dist_km,
            flooded_segments_count=0,
            avoided_flooded_segments=avoided,
            is_safe=True,
            summary=f"Avoids {len(avoided)} simulated high-depth segments" if avoided else "No simulated high-depth segments on this corridor",
        ),
        RouteOption(
            id="shortest",
            name="Unpenalized shortest model route",
            tag="Simulation output",
            geometry=path_to_geojson_linestring(baseline_graph, baseline_path),
            eta_seconds=base_eta_s,
            eta_minutes=max(round(base_eta_s / 60), 1),
            distance_km=base_dist_km,
            flooded_segments_count=len(baseline_flooded_segments),
            avoided_flooded_segments=[],
            is_safe=len(baseline_flooded_segments) == 0,
            summary=(
                f"Crosses {len(baseline_flooded_segments)} simulated high-depth segment(s)"
                if baseline_flooded_segments
                else "Direct route"
            ),
        ),
        RouteOption(
            id="alternate",
            name="Alternate Route",
            tag="Moderate Risk",
            geometry=path_to_geojson_linestring(flood_graph, alt_path),
            eta_seconds=alt_eta_s,
            eta_minutes=max(round(alt_eta_s / 60), 1),
            distance_km=alt_dist_km,
            flooded_segments_count=len(alt_flooded_segments),
            avoided_flooded_segments=[e for e in baseline_flooded_segments if e not in set(path_edge_ids(flood_graph, alt_path))],
            is_safe=len(alt_flooded_segments) == 0,
            summary="Secondary detour corridor",
        ),
    ]

    critical_risk = None
    all_infra = cache.provider.get_critical_infrastructure()
    if all_infra:
        nearest_infra = min(
            all_infra,
            key=lambda i: math.hypot(i.lat - req.end.lat, i.lng - req.end.lng),
        )
        if math.hypot(nearest_infra.lat - req.end.lat, nearest_infra.lng - req.end.lng) < 0.002:
            risk = next(
                (r for r in scenario.critical_access_risks if r.infra_id == nearest_infra.infra_id),
                None,
            )
            if risk:
                critical_risk = CriticalAccessRiskSchema(
                    infra_id=risk.infra_id,
                    infra_type=risk.infra_type,
                    infra_name=risk.infra_name,
                    access_redundancy_score=risk.access_redundancy_score,
                    message=risk.message,
                )

    return RouteResponse(
        route_geometry=path_to_geojson_linestring(flood_graph, route_path),
        eta_seconds=rec_eta_s,
        avoided_flooded_segments=avoided,
        baseline_route_geometry=path_to_geojson_linestring(baseline_graph, baseline_path),
        baseline_eta_seconds=base_eta_s,
        critical_access_risk=critical_risk,
        routes=options,
        active_vehicle=req.vehicle_type,
        routing_context=routing_context,
    )
