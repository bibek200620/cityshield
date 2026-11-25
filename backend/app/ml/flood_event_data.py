"""Validation for sourced Bengaluru flood-event evidence.

The source inventory can include coarse narrative references for research
provenance. Only records with adequate event time, geometry, outcome evidence,
and event rainfall may be marked eligible for model evaluation.
"""
from __future__ import annotations

import json
import random
from datetime import date, datetime
from pathlib import Path
from typing import Any, Mapping, Sequence


MANIFEST_PATH = Path(__file__).with_name("flood_event_sources.json")
SCHEMA_VERSION = "1.0.0"


class FloodEventManifestError(ValueError):
    """Raised when a flood-event source manifest violates its data contract."""


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Any]:
    """Load and validate a JSON source manifest."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FloodEventManifestError(f"Cannot read flood-event manifest: {exc}") from exc
    validate_manifest(payload)
    return payload


def validate_manifest(payload: Any) -> None:
    """Validate source provenance, record identity and evaluation eligibility."""
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        raise FloodEventManifestError(f"schema_version must be {SCHEMA_VERSION}")

    sources = payload.get("sources")
    events = payload.get("events")
    if not isinstance(sources, list) or not isinstance(events, list):
        raise FloodEventManifestError("sources and events must be arrays")

    source_ids: set[str] = set()
    for source in sources:
        if not isinstance(source, dict):
            raise FloodEventManifestError("each source must be an object")
        source_id = _required_text(source, "source_id")
        if source_id in source_ids:
            raise FloodEventManifestError(f"duplicate source_id: {source_id}")
        source_ids.add(source_id)
        for key in ("title", "publisher", "url", "source_basis", "reuse_status"):
            _required_text(source, key)
        published_at = source.get("published_at")
        if published_at is not None:
            _parse_datetime(published_at, f"source {source_id} published_at")

    record_ids: set[str] = set()
    event_keys: set[tuple[str, str, tuple[str, ...]]] = set()
    for event in events:
        if not isinstance(event, dict):
            raise FloodEventManifestError("each event must be an object")
        record_id = _required_text(event, "record_id")
        if record_id in record_ids:
            raise FloodEventManifestError(f"duplicate record_id: {record_id}")
        record_ids.add(record_id)
        source_id = _required_text(event, "source_id")
        if source_id not in source_ids:
            raise FloodEventManifestError(f"event {record_id} references unknown source_id {source_id}")
        _required_text(event, "event_kind")

        event_time = event.get("event_time")
        if not isinstance(event_time, dict):
            raise FloodEventManifestError(f"event {record_id} event_time must be an object")
        event_date = event_time.get("date")
        precision = _required_text(event_time, "precision")
        if event_date is not None:
            _parse_date(event_date, f"event {record_id} date")
        _parse_datetime(event_time.get("report_published_at"), f"event {record_id} report_published_at")

        location = event.get("location")
        if not isinstance(location, dict):
            raise FloodEventManifestError(f"event {record_id} location must be an object")
        names = location.get("area_names")
        if not isinstance(names, list) or not names or any(not isinstance(name, str) or not name.strip() for name in names):
            raise FloodEventManifestError(f"event {record_id} requires named locations")
        _required_text(location, "precision")
        _required_text(location, "geocoding_provenance")
        if event_date is not None:
            normalized_names = tuple(sorted(name.strip().casefold() for name in names))
            duplicate_key = (source_id, event_date, normalized_names)
            if duplicate_key in event_keys:
                raise FloodEventManifestError(f"duplicate source/date/location event: {source_id}/{event_date}")
            event_keys.add(duplicate_key)
        geometry = location.get("geometry")
        if geometry is not None:
            _validate_point_geometry(geometry, record_id)

        flags = event.get("quality_flags")
        if not isinstance(flags, list) or any(not isinstance(flag, str) or not flag.strip() for flag in flags):
            raise FloodEventManifestError(f"event {record_id} quality_flags must be an array of strings")
        if not isinstance(event.get("evaluation_eligible"), bool):
            raise FloodEventManifestError(f"event {record_id} evaluation_eligible must be boolean")

        observation = event.get("observation")
        if not isinstance(observation, dict):
            raise FloodEventManifestError(f"event {record_id} observation must be an object")
        if event["evaluation_eligible"]:
            if event_date is None or precision not in {"minute", "hour", "day"}:
                raise FloodEventManifestError(f"event {record_id} needs a bounded event time for evaluation")
            _required_text(event, "storm_group_id")
            if geometry is None:
                raise FloodEventManifestError(f"event {record_id} needs verified geometry for evaluation")
            if not observation.get("reported_flooded_streets") and not observation.get("observed_inundation_geometry"):
                raise FloodEventManifestError(f"event {record_id} needs observed flood outcome evidence")
            rainfall = observation.get("rainfall_timeseries_mm_hr")
            if not isinstance(rainfall, list) or not rainfall or any(
                isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 for value in rainfall
            ):
                raise FloodEventManifestError(f"event {record_id} needs a non-negative event rainfall series")
        elif not _optional_text(event, "evaluation_exclusion_reason"):
            raise FloodEventManifestError(f"event {record_id} must explain why it is not evaluation eligible")


def partition_event_groups(
    events: Sequence[Mapping[str, Any]],
    *,
    test_fraction: float = 0.2,
    seed: int = 42,
) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    """Split eligible records by complete storm groups, with stable ordering.

    The caller must provide evaluation-eligible records only. A storm is the
    grouping unit because multiple observations from one storm must not appear
    in both partitions. This utility partitions records; it does not score a
    flood model or make the records valid ground truth.
    """
    if (
        isinstance(test_fraction, bool)
        or not isinstance(test_fraction, (int, float))
        or not 0 < test_fraction < 1
    ):
        raise FloodEventManifestError("test_fraction must be between 0 and 1")

    record_ids: set[str] = set()
    groups: dict[str, list[Mapping[str, Any]]] = {}
    for event in events:
        if not isinstance(event, Mapping):
            raise FloodEventManifestError("each event must be an object")
        record_id = _required_text(dict(event), "record_id")
        if record_id in record_ids:
            raise FloodEventManifestError(f"duplicate record_id: {record_id}")
        record_ids.add(record_id)
        if event.get("evaluation_eligible") is not True:
            raise FloodEventManifestError(f"event {record_id} is not evaluation eligible")
        storm_group_id = _required_text(dict(event), "storm_group_id")
        groups.setdefault(storm_group_id, []).append(event)

    group_ids = sorted(groups)
    if len(group_ids) < 2:
        raise FloodEventManifestError("at least two eligible storm groups are required for a holdout split")

    test_count = max(1, min(len(group_ids) - 1, round(len(group_ids) * test_fraction)))
    test_groups = set(random.Random(seed).sample(group_ids, test_count))
    train = [
        record
        for group_id in group_ids
        if group_id not in test_groups
        for record in sorted(groups[group_id], key=lambda item: str(item["record_id"]))
    ]
    test = [
        record
        for group_id in group_ids
        if group_id in test_groups
        for record in sorted(groups[group_id], key=lambda item: str(item["record_id"]))
    ]
    return train, test


def _required_text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise FloodEventManifestError(f"{key} must be a non-empty string")
    return value.strip()


def _optional_text(payload: dict[str, Any], key: str) -> bool:
    value = payload.get(key)
    return isinstance(value, str) and bool(value.strip())


def _parse_date(value: Any, field: str) -> None:
    if not isinstance(value, str):
        raise FloodEventManifestError(f"{field} must be an ISO date string")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise FloodEventManifestError(f"{field} must be an ISO date string") from exc


def _parse_datetime(value: Any, field: str) -> None:
    if not isinstance(value, str):
        raise FloodEventManifestError(f"{field} must be an ISO datetime string")
    try:
        datetime.fromisoformat(value)
    except ValueError as exc:
        raise FloodEventManifestError(f"{field} must be an ISO datetime string") from exc


def _validate_point_geometry(geometry: Any, record_id: str) -> None:
    """Validate GeoJSON Point coordinate order and WGS84 bounds."""
    if not isinstance(geometry, dict) or geometry.get("type") != "Point":
        raise FloodEventManifestError(f"event {record_id} geometry must be a GeoJSON Point or null")
    coordinates = geometry.get("coordinates")
    if (
        not isinstance(coordinates, list)
        or len(coordinates) < 2
        or any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in coordinates[:2])
    ):
        raise FloodEventManifestError(f"event {record_id} Point must contain [longitude, latitude]")
    longitude, latitude = coordinates[:2]
    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        raise FloodEventManifestError(f"event {record_id} Point is outside WGS84 coordinate bounds")
