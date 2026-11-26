"""City car routing against the Valhalla OpenStreetMap road network."""
from __future__ import annotations

import json
from math import isfinite
from threading import Lock
from time import monotonic, sleep, time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.config import settings
from app.routing.conditions import PROVIDER_ERRORS, annotate_conditions, fetch_json, iso_utc

router = APIRouter()
VALHALLA_URL = "https://valhalla1.openstreetmap.de/route"
_provider_lock = Lock()
_next_provider_call = 0.0


class DrivingPoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class DrivingRequest(BaseModel):
    source: DrivingPoint
    destination: DrivingPoint


def decode_polyline6(shape: str) -> list[list[float]]:
    coords = []
    latitude = longitude = 0
    index = 0

    def delta() -> int:
        nonlocal index
        value = 0
        for shift in range(0, 35, 5):
            digit = ord(shape[index]) - 63
            index += 1
            if not 0 <= digit <= 63:
                raise ValueError("Invalid polyline character")
            value |= (digit & 31) << shift
            if digit < 32:
                return ~(value >> 1) if value & 1 else value >> 1
        raise ValueError("Invalid polyline length")

    while index < len(shape):
        latitude += delta()
        longitude += delta()
        if abs(latitude) > 90_000_000 or abs(longitude) > 180_000_000:
            raise ValueError("Invalid polyline coordinate")
        coords.append([longitude / 1_000_000, latitude / 1_000_000])
    if len(coords) < 2:
        raise ValueError("Route has no road geometry")
    return coords


def query_valhalla(req: DrivingRequest, *, shortest: bool) -> dict:
    global _next_provider_call
    costing_options = {"speed_types": ["freeflow", "constrained"]}
    if shortest:
        costing_options["shortest"] = True
    request_body = {
        "locations": [{"lat": point.lat, "lon": point.lng} for point in (req.source, req.destination)],
        "costing": "auto",
        "shape_format": "polyline6",
        "directions_type": "none",
        "units": "kilometers",
        "alternates": 0 if shortest else 2,
        "costing_options": {"auto": costing_options},
    }
    url = VALHALLA_URL + "?" + urlencode({"json": json.dumps(request_body, separators=(",", ":"))})
    request = Request(url, headers={"User-Agent": "CityShield/0.1 (local research)", "X-Client-Id": "cityshield-local"})
    # Serialize starts across requests to respect the public demo service limit.
    with _provider_lock:
        sleep(max(0, _next_provider_call - monotonic()))
        _next_provider_call = monotonic() + 1.1
        with urlopen(request, timeout=8) as response:
            return json.load(response)


def get_options(payload: dict) -> list[dict]:
    return [payload["trip"], *(item["trip"] for item in payload.get("alternates", []))]


def shape_option(trip: dict, label: str) -> dict:
    length = float(trip["summary"]["length"])
    seconds = float(trip["summary"]["time"])
    if not all(isfinite(value) and value > 0 for value in (length, seconds)):
        raise ValueError("Invalid route summary")
    return {
        "labels": [label],
        "distance_km": length,
        "eta_seconds": seconds,
        "coordinates": decode_polyline6(trip["legs"][0]["shape"]),
    }


def valhalla_options(req: DrivingRequest) -> tuple[list[dict], dict | None]:
    try:
        candidates = [shape_option(trip, "Alternative") for trip in get_options(query_valhalla(req, shortest=False))]
    except HTTPError as exc:
        if exc.code == 400:
            raise HTTPException(422, "No car route found. Try points closer to a mapped road.") from exc
        raise HTTPException(503, "The road routing provider is unavailable.") from exc
    except PROVIDER_ERRORS as exc:
        raise HTTPException(503, "The road routing provider is unavailable.") from exc
    try:
        shortest = shape_option(query_valhalla(req, shortest=True)["trip"], "Shortest distance")
    except PROVIDER_ERRORS:
        shortest = None
    return candidates, shortest


def traffic_segments(route: dict, coordinate_count: int) -> list[dict] | None:
    """Map TomTom point-index ranges to disjoint, drawable traffic spans."""
    sections = route.get("sections")
    if not isinstance(sections, list):
        return [{"start_index": 0, "end_index": coordinate_count - 1, "level": "clear"}] if route["summary"].get("trafficDelayInSeconds") == 0 else None
    severity = {"clear": 0, "unknown": 1, "slow": 2, "heavy": 3}
    levels = ["clear"] * (coordinate_count - 1)
    for section in sections:
        if not isinstance(section, dict) or section.get("sectionType") != "TRAFFIC":
            continue
        start, end = section.get("startPointIndex"), section.get("endPointIndex")
        if type(start) is not int or type(end) is not int or not 0 <= start < end < coordinate_count:
            return None
        magnitude = section.get("magnitudeOfDelay")
        speed = section.get("effectiveSpeedInKmh")
        if section.get("simpleCategory") == "ROAD_CLOSURE" or magnitude in (3, 4) or speed == 0:
            level = "heavy"
        elif magnitude in (1, 2):
            level = "slow"
        else:
            level = "unknown"
        for index in range(start, end):
            if severity[level] > severity[levels[index]]:
                levels[index] = level
    spans = []
    start = 0
    for end in range(1, len(levels) + 1):
        if end == len(levels) or levels[end] != levels[start]:
            spans.append({"start_index": start, "end_index": end, "level": levels[start]})
            start = end
    return spans


def tomtom_options(req: DrivingRequest, key: str, *, shortest: bool) -> list[dict]:
    locations = ":".join(f"{p.lat:.6f},{p.lng:.6f}" for p in (req.source, req.destination))
    payload = fetch_json(f"https://api.tomtom.com/routing/1/calculateRoute/{locations}/json", {
        "key": key, "traffic": "true", "travelMode": "car",
        "routeType": "shortest" if shortest else "fastest",
        "maxAlternatives": 0 if shortest else 2, "computeTravelTimeFor": "all",
        "routeRepresentation": "polyline", "sectionType": "traffic",
    })
    options = []
    for route in payload["routes"]:
        summary = route["summary"]
        length = float(summary["lengthInMeters"])
        seconds = float(summary["travelTimeInSeconds"])
        coords = [
            [float(point["longitude"]), float(point["latitude"])]
            for leg in route["legs"] for point in leg["points"]
        ]
        if len(coords) < 2 or not all(isfinite(v) and v > 0 for v in (length, seconds)):
            raise ValueError("Invalid driving route summary")
        free_flow = summary.get("noTrafficTravelTimeInSeconds")
        options.append({
            "labels": ["Alternative"],
            "distance_km": length / 1000,
            "eta_seconds": seconds,
            "coordinates": coords,
            "traffic_time_delta_seconds": round(seconds - free_flow) if isinstance(free_flow, (int, float)) else None,
            "traffic_segments": traffic_segments(route, len(coords)),
        })
    if not options:
        raise ValueError("No traffic routes returned")
    return options


def compare_options(candidates: list[dict], shortest: dict | None) -> list[dict]:
    if shortest is not None and not any(option["coordinates"] == shortest["coordinates"] for option in candidates):
        candidates.append({**shortest, "labels": ["Alternative"]})
    candidates.sort(key=lambda option: option["eta_seconds"])
    fastest = candidates[0]
    fastest["labels"] = ["Best estimated time", *[label for label in fastest["labels"] if label != "Alternative"]]
    options = [fastest]
    if shortest is not None:
        distance_option = min(candidates, key=lambda option: option["distance_km"])
        if distance_option["coordinates"] == fastest["coordinates"]:
            fastest["labels"].append("Shortest distance")
        else:
            distance_option["labels"] = ["Shortest distance", *[label for label in distance_option["labels"] if label not in ("Alternative", "Shortest distance")]]
            options.append(distance_option)
    for candidate in candidates:
        if len(options) == 3:
            break
        if not any(candidate["coordinates"] == known["coordinates"] for known in options):
            options.append(candidate)
    return options


def recommend_route(candidates: list[dict]) -> dict:
    """Use comparable hazards first and preserve the provider ETA as the tie-breaker."""
    comparable = candidates
    if all("nearby_flood_reports" in option for option in comparable):
        fewest = min(option["nearby_flood_reports"] for option in comparable)
        comparable = [option for option in comparable if option["nearby_flood_reports"] == fewest]
    if all(option.get("runoff_comparable", False) for option in comparable):
        lowest = min(option["runoff"]["forecast_km"] for option in comparable)
        comparable = [option for option in comparable if round(option["runoff"]["forecast_km"] - lowest, 2) < 0.1]
    return min(comparable, key=lambda option: option["eta_seconds"])


@router.post("/api/drive/routes")
def drive_routes(req: DrivingRequest) -> dict:
    if any(not (12.62 <= p.lat <= 13.16 and 77.44 <= p.lng <= 77.80) for p in (req.source, req.destination)):
        raise HTTPException(422, "Choose a source and destination in the Bengaluru map area.")
    if req.source == req.destination:
        raise HTTPException(422, "Choose a different destination.")

    key = settings.TOMTOM_API_KEY.get_secret_value().strip() if settings.TOMTOM_API_KEY else ""
    traffic = {"status": "unavailable", "message": "Live traffic is not configured."}
    source = "FOSSGIS Valhalla · OpenStreetMap"
    candidates = []
    shortest = None
    if key:
        try:
            candidates = tomtom_options(req, key, shortest=False)
            traffic = {"status": "ready", "message": "TomTom traffic-aware travel times.", "checked_at": iso_utc(int(time()))}
            source = "TomTom Routing"
            try:
                shortest = tomtom_options(req, key, shortest=True)[0]
            except PROVIDER_ERRORS:
                pass
        except PROVIDER_ERRORS:
            traffic["message"] = "TomTom traffic is unavailable. Showing road-network estimates."
    if not candidates:
        candidates, shortest = valhalla_options(req)

    distinct = []
    for option in [*candidates, *([shortest] if shortest else [])]:
        if not any(existing["coordinates"] == option["coordinates"] for existing in distinct):
            distinct.append(option)
    conditions = annotate_conditions(distinct, key or None)
    recommended = recommend_route(distinct)
    options = compare_options(distinct, shortest)
    if recommended is not options[0]:
        recommended["labels"] = [label for label in recommended["labels"] if label != "Alternative"]
        recommended["labels"].insert(0, "Recommended for lower flood exposure")
        options = [recommended, *(option for option in options if option is not recommended)][:3]
    return {
        "routes": [{"id": str(i), **option} for i, option in enumerate(options)],
        "shortest_available": shortest is not None,
        "source": source,
        "traffic": traffic,
        **conditions,
    }
