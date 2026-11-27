"""Match a bounded set of TomTom traffic-flow samples to the selected road path."""
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from math import hypot, isfinite
from threading import BoundedSemaphore

from shapely.geometry import LineString, Point
from shapely.ops import transform

from app.core.config import settings
from app.routing.conditions import PROJECT, PROVIDER_ERRORS, fetch_json

FLOW_URL = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/18/json"
_slots = BoundedSemaphore(2)
_workers = ThreadPoolExecutor(max_workers=6)


@lru_cache(maxsize=256)
def flow_sample(lat: float, lng: float, _slot: int) -> tuple[str, LineString] | None:
    key = settings.TOMTOM_API_KEY
    if not key:
        return None
    try:
        data = fetch_json(FLOW_URL, {"key": key.get_secret_value().strip(), "point": f"{lat},{lng}"})["flowSegmentData"]
        confidence = float(data["confidence"])
        if not .6 <= confidence <= 1:
            return None
        coordinates = [(float(point["longitude"]), float(point["latitude"])) for point in data["coordinates"]["coordinate"]]
        if len(coordinates) < 2 or not all(isfinite(lng) and isfinite(lat) for lng, lat in coordinates):
            return None
        segment = transform(PROJECT, LineString(coordinates))
        if data.get("roadClosure") is True:
            return "heavy", segment
        free = float(data["freeFlowSpeed"])
        speed = float(data["currentSpeed"])
        if not isfinite(speed) or not isfinite(free) or speed < 0 or free <= 0:
            return None
        return ("heavy" if speed / free < .50 else "slow" if speed / free < .80 else "clear"), segment
    except PROVIDER_ERRORS:
        return None


def spans_for_levels(levels: list[str]) -> list[dict]:
    spans = []
    start = 0
    for end in range(1, len(levels) + 1):
        if end == len(levels) or levels[end] != levels[start]:
            spans.append({"start_index": start, "end_index": end, "level": levels[start]})
            start = end
    return spans


def match_flow_segments(path: LineString, samples: list[tuple[str, LineString]]) -> list[dict]:
    # Keep off-route and opposing carriageways unclassified. Compare direction
    # in projected metres since Flow returns the nearest road to each sample point.
    severity = {"unknown": 0, "clear": 1, "slow": 2, "heavy": 3}
    levels = ["unknown"] * (len(path.coords) - 1)
    for level, road in samples:
        if road.length < 5:
            continue
        bounds = road.buffer(18)
        for index, (a, b) in enumerate(zip(path.coords[:-1], path.coords[1:])):
            if severity[level] <= severity[levels[index]] or a == b:
                continue
            start, end = Point(a), Point(b)
            if not (bounds.covers(start) and bounds.covers(end)):
                continue
            along = road.project(end) - road.project(start)
            if along >= .65 * hypot(b[0] - a[0], b[1] - a[1]):
                levels[index] = level
    return spans_for_levels(levels)


def sample_route_flow(coordinates: list[tuple[float, float]], slot: int) -> list[dict] | None:
    if not settings.TOMTOM_API_KEY or not _slots.acquire(blocking=False):
        return None
    try:
        path = LineString(coordinates)
        points = [path.interpolate(fraction, normalized=True) for fraction in (.06, .22, .38, .54, .72, .90)]
        rounded = {(round(point.y, 5), round(point.x, 5)) for point in points}
        futures = [_workers.submit(flow_sample, lat, lng, slot) for lat, lng in rounded]
        samples = [sample for future in futures if (sample := future.result()) is not None]
        if not samples:
            return None
        return match_flow_segments(transform(PROJECT, path), samples)
    finally:
        _slots.release()
