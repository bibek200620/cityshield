"""Validate historical storm inputs before they reach a drainage comparison."""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

STORM_DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "storm_events"
SCHEMA_VERSION = "1.0"
EVENT_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}")


@dataclass(frozen=True)
class StormSource:
    title: str
    url: str
    reference: str
    reuse_terms: str
    allow_api_display: bool


@dataclass(frozen=True)
class StormGauge:
    id: str
    lat: float
    lng: float
    location_reference: str
    rainfall_mm: dict[datetime, float]


@dataclass(frozen=True)
class StormSensor:
    id: str
    lat: float
    lng: float
    location_reference: str
    node_id: str
    gauge_id: str
    mapping_reference: str
    invert_elevation_m: float
    vertical_datum: str
    levels_m: dict[datetime, float]


@dataclass(frozen=True)
class StormEvent:
    event_id: str
    storm_group_id: str
    catchment_id: str
    network_id: str
    network_version: str
    network_basis: str
    network_source: str
    network_reference: str
    partition: str
    partition_reference: str
    start_utc: datetime
    end_utc: datetime
    interval_minutes: int
    time_zone: str
    source: StormSource
    gauges: dict[str, StormGauge]
    sensors: dict[str, StormSensor]


@dataclass(frozen=True)
class StormImportResult:
    event: StormEvent | None
    report: dict[str, Any]


@dataclass(frozen=True)
class _Grid:
    start: datetime
    end: datetime
    step: timedelta
    zone: ZoneInfo

    @property
    def count(self) -> int:
        return (self.end - self.start) // self.step


@dataclass
class _Report:
    sha256: str | None
    errors: list[dict[str, str]] = field(default_factory=list)
    warnings: list[dict[str, str]] = field(default_factory=list)
    series: dict[str, dict[str, Any]] = field(default_factory=dict)

    def error(self, code: str, path: str, message: str) -> None:
        self.errors.append({"code": code, "path": path, "message": message})

    def text(self, data: dict, key: str, path: str) -> str:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        self.error("required_text", f"{path}.{key}", "Provide a non-empty string.")
        return ""

    def number(self, value: Any, path: str) -> float | None:
        try:
            if type(value) in {int, float} and math.isfinite(value):
                return float(value)
        except OverflowError:
            pass
        self.error("invalid_number", path, "Provide a finite JSON number.")
        return None

    def object(self, value: Any, path: str) -> dict:
        if isinstance(value, dict):
            return value
        self.error("invalid_object", path, "Provide a JSON object.")
        return {}

    def array(self, value: Any, path: str) -> list:
        if isinstance(value, list) and value:
            return value
        self.error("missing_rows", path, "Provide at least one row.")
        return []

    def result(self, event_id: str | None = None, event: StormEvent | None = None) -> StormImportResult:
        return StormImportResult(event, {
            "schema_version": SCHEMA_VERSION,
            "event_id": event_id,
            "ready": event is not None,
            "sha256": self.sha256,
            "errors": self.errors,
            "warnings": self.warnings,
            "series": self.series,
        })


def load_storm_bundle(path: Path) -> StormImportResult:
    """Read a local source file and return its normalized event and validation report."""
    try:
        payload = path.read_bytes()
    except OSError as exc:
        report = _Report(None)
        report.error("read_failed", "$", f"Could not read the observation bundle: {exc.strerror or exc}")
        return report.result()
    return inspect_storm_bundle(payload)


def inspect_storm_bundle(payload: bytes) -> StormImportResult:
    """Check an exact byte sequence so the validation hash matches the installed file."""
    report = _Report(hashlib.sha256(payload).hexdigest())
    try:
        data = report.object(json.loads(payload.decode("utf-8-sig"), object_pairs_hook=_unique_keys), "$")
    except (ValueError, RecursionError) as exc:
        report.error("invalid_json", "$", f"Provide a valid UTF-8 JSON bundle: {exc}")
        return report.result()

    event_id = report.text(data, "event_id", "$")
    if event_id and not EVENT_ID_PATTERN.fullmatch(event_id):
        report.error("invalid_event_id", "$.event_id", "Use 1–80 ASCII letters, digits, underscores or hyphens, starting with a letter or digit.")
    if data.get("schema_version") != SCHEMA_VERSION:
        report.error("unsupported_schema", "$.schema_version", f"Use schema version {SCHEMA_VERSION}.")
    storm_group_id = report.text(data, "storm_group_id", "$")
    catchment_id = report.text(data, "catchment_id", "$")
    partition = report.text(data, "partition", "$")
    if partition and partition not in {"development", "holdout"}:
        report.error("invalid_partition", "$.partition", "Use development or holdout for the entire storm group.")
    partition_reference = report.text(data, "partition_reference", "$")
    time_zone = report.text(data, "time_zone", "$")
    grid = _check_grid(data, time_zone, report)
    source = _check_source(data.get("source"), report)

    network = report.object(data.get("network"), "$.network")
    network_id = report.text(network, "id", "$.network")
    network_version = report.text(network, "version", "$.network")
    network_basis = report.text(network, "basis", "$.network")
    network_source = report.text(network, "source", "$.network")
    network_reference = report.text(network, "reference", "$.network")
    if network_basis and network_basis != "surveyed":
        report.error("unsurveyed_network", "$.network.basis", "Use a surveyed drainage network for comparisons with observed levels.")

    gauges: dict[str, StormGauge] = {}
    sensors: dict[str, StormSensor] = {}
    gauge_rows = report.array(data.get("gauges"), "$.gauges")
    sensor_rows = report.array(data.get("sensors"), "$.sensors")
    if grid:
        gauges = _check_gauges(gauge_rows, grid, report)
        sensors = _check_sensors(sensor_rows, gauges, grid, report)
    if report.errors or grid is None or source is None:
        return report.result(event_id or None)
    return report.result(event_id, StormEvent(
        event_id=event_id,
        storm_group_id=storm_group_id,
        catchment_id=catchment_id,
        network_id=network_id,
        network_version=network_version,
        network_basis=network_basis,
        network_source=network_source,
        network_reference=network_reference,
        partition=partition,
        partition_reference=partition_reference,
        start_utc=grid.start,
        end_utc=grid.end,
        interval_minutes=grid.step // timedelta(minutes=1),
        time_zone=time_zone,
        source=source,
        gauges=gauges,
        sensors=sensors,
    ))


def storm_partition_issues(events: Iterable[StormEvent]) -> list[dict[str, str]]:
    """Detect duplicate event identities and split leakage across installed storms."""
    report = _Report(None)
    groups: dict[str, str] = {}
    identifiers: set[str] = set()
    for event in events:
        path = f"events.{event.event_id}"
        if event.event_id in identifiers:
            report.error("duplicate_event_id", path, "Use a unique event_id across the corpus.")
        identifiers.add(event.event_id)
        partition = groups.setdefault(event.storm_group_id, event.partition)
        if partition != event.partition:
            report.error("storm_group_leakage", path, "Assign every event with the same storm_group_id to one partition.")
    return report.errors


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key {key!r}")
        result[key] = value
    return result


def _timestamp(value: Any, zone: ZoneInfo, path: str, report: _Report) -> datetime | None:
    try:
        if not isinstance(value, str) or "T" not in value:
            raise ValueError
        timestamp = datetime.fromisoformat(value)
        offset = timestamp.utcoffset()
        if offset is None or (
            offset != timedelta(0) and offset != timestamp.astimezone(zone).utcoffset()
        ):
            raise ValueError
        return timestamp.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        report.error("invalid_timestamp", path, "Use an ISO timestamp with Z or the offset for the declared time zone.")
        return None


def _check_grid(data: dict, time_zone: str, report: _Report) -> _Grid | None:
    try:
        zone = ZoneInfo(time_zone)
    except (KeyError, ValueError):
        report.error("invalid_timezone", "$.time_zone", "Provide an available IANA time zone, such as Asia/Kolkata.")
        return None
    start = _timestamp(data.get("start_at"), zone, "$.start_at", report)
    end = _timestamp(data.get("end_at"), zone, "$.end_at", report)
    minutes = data.get("interval_minutes")
    if type(minutes) is not int or not 1 <= minutes < 60:
        report.error("invalid_interval", "$.interval_minutes", "Use a whole number of minutes from 1 to 59.")
        return None
    step = timedelta(minutes=minutes)
    if not (start and end):
        return None
    span = end - start
    if start.second or start.microsecond or span < 2 * step or span % step:
        report.error("unaligned_window", "$.end_at", "Begin on a whole minute and cover at least two complete intervals.")
        return None
    return _Grid(start, end, step, zone)


def _check_source(data_value: Any, report: _Report) -> StormSource | None:
    path = "$.source"
    data = report.object(data_value, path)
    title = report.text(data, "title", path)
    url = report.text(data, "url", path)
    reference = report.text(data, "reference", path)
    reuse_terms = report.text(data, "reuse_terms", path)
    try:
        parsed_url = urlsplit(url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
            raise ValueError
    except ValueError:
        report.error("invalid_source_url", f"{path}.url", "Provide the source or source owner's HTTP(S) page.")
    allow_api_display = data.get("allow_api_display")
    if not isinstance(allow_api_display, bool):
        report.error("display_permission_missing", f"{path}.allow_api_display", "Set true only when the reuse terms authorize displaying observations in the API.")
        return None
    if not allow_api_display:
        report.warnings.append({
            "code": "local_only",
            "path": f"{path}.allow_api_display",
            "message": "Reuse terms allow local inspection only. The observation bundle is private to the API.",
        })
    return StormSource(title, url, reference, reuse_terms, allow_api_display)


def _site(data: dict, path: str, report: _Report) -> tuple[float, float, str] | None:
    lat = report.number(data.get("lat"), f"{path}.lat")
    lng = report.number(data.get("lng"), f"{path}.lng")
    reference = report.text(data, "location_reference", path)
    if lat is None or lng is None:
        return None
    if not -90 <= lat <= 90 or not -180 <= lng <= 180:
        report.error("invalid_coordinates", path, "Provide verified WGS84 latitude and longitude.")
        return None
    return lat, lng, reference


def _check_gauges(rows: list, grid: _Grid, report: _Report) -> dict[str, StormGauge]:
    gauges: dict[str, StormGauge] = {}
    seen: set[str] = set()
    factors = {"mm": 1.0, "mm/h": grid.step / timedelta(hours=1)}
    for index, row in enumerate(rows):
        path = f"$.gauges[{index}]"
        data = report.object(row, path)
        key = report.text(data, "id", path)
        if key in seen:
            report.error("duplicate_gauge", f"{path}.id", "Use a unique gauge ID.")
            continue
        seen.add(key)
        coordinates = _site(data, path, report)
        unit = report.text(data, "unit", path)
        factor = factors.get(unit)
        if factor is None:
            report.error("unsupported_rainfall_unit", f"{path}.unit", "Use interval total mm or interval-mean mm/h. Convert cumulative counts first.")
            continue
        values = _check_values(data.get("readings"), path, grid, report, factor=factor)
        if key and coordinates:
            gauges[key] = StormGauge(key, *coordinates, values)
    return gauges


def _check_sensors(rows: list, gauges: dict[str, StormGauge], grid: _Grid, report: _Report) -> dict[str, StormSensor]:
    sensors: dict[str, StormSensor] = {}
    seen: set[str] = set()
    factors = {"m": 1.0, "cm": 0.01, "mm": 0.001}
    for index, row in enumerate(rows):
        path = f"$.sensors[{index}]"
        data = report.object(row, path)
        key = report.text(data, "id", path)
        if key in seen:
            report.error("duplicate_sensor", f"{path}.id", "Use a unique water-level sensor ID.")
            continue
        seen.add(key)
        coordinates = _site(data, path, report)
        node = report.text(data, "node_id", path)
        gauge = report.text(data, "gauge_id", path)
        if gauge and gauge not in gauges:
            report.error("unmatched_gauge", f"{path}.gauge_id", "Reference a gauge in this catchment bundle.")
        mapping = report.text(data, "mapping_reference", path)
        invert = report.number(data.get("invert_elevation_m"), f"{path}.invert_elevation_m")
        datum = report.text(data, "vertical_datum", path)
        unit = report.text(data, "unit", path)
        factor = factors.get(unit)
        if factor is None:
            report.error("unsupported_level_unit", f"{path}.unit", "Use m, cm or mm.")
            continue
        reference = report.text(data, "measurement_reference", path)
        if reference not in {"drain_invert", "water_surface_elevation"}:
            report.error("unsupported_level_reference", f"{path}.measurement_reference", "Use drain_invert or water_surface_elevation in the declared vertical datum.")
            continue
        if invert is None:
            continue
        correction = invert if reference == "water_surface_elevation" else 0.0
        values = _check_values(data.get("readings"), path, grid, report, factor=factor, correction=correction, allow_start=True)
        if key and coordinates:
            sensors[key] = StormSensor(key, *coordinates, node, gauge, mapping, invert, datum, values)
    return sensors


def _check_values(
    raw: Any,
    path: str,
    grid: _Grid,
    report: _Report,
    *,
    factor: float,
    correction: float = 0.0,
    allow_start: bool = False,
) -> dict[datetime, float]:
    rows = report.array(raw, f"{path}.readings")
    values: dict[datetime, float] = {}
    seen: set[datetime] = set()
    rejected = 0
    for index, row in enumerate(rows):
        row_path = f"{path}.readings[{index}]"
        data = report.object(row, row_path)
        timestamp = _timestamp(data.get("at"), grid.zone, f"{row_path}.at", report)
        if timestamp is None:
            continue
        offset = timestamp - grid.start
        first = grid.start if allow_start else grid.start + grid.step
        if timestamp < first or timestamp > grid.end or offset % grid.step:
            report.error("off_grid_reading", f"{row_path}.at", "Use the declared window and interval-end timestamps.")
            continue
        if timestamp in seen:
            report.error("duplicate_timestamp", f"{row_path}.at", "Keep one reviewed reading per UTC instant per instrument.")
            continue
        seen.add(timestamp)
        qc = data.get("qc")
        if qc in ("suspect", "invalid", "missing"):
            rejected += 1
            continue
        if qc != "valid":
            report.error("unknown_qc", f"{row_path}.qc", "Map the original quality flag to valid, suspect, invalid or missing.")
            continue
        raw_value = report.number(data.get("value"), f"{row_path}.value")
        if raw_value is None:
            continue
        value = raw_value * factor - correction
        if not math.isfinite(value) or value < 0:
            report.error("invalid_normalized_value", f"{row_path}.value", "Normalized rainfall and depth above the invert must be finite and nonnegative.")
            continue
        values[timestamp] = value

    ordered = dict(sorted(values.items()))
    endpoints = [ts for ts in ordered if ts != grid.start]
    missing = grid.count - len(endpoints)
    stats = {"input_rows": len(rows), "accepted_rows": len(values), "rejected_qc_rows": rejected,
             "expected_interval_ends": grid.count, "missing_interval_ends": missing}
    report.series[path] = stats
    if missing:
        first_missing = grid.start + grid.step
        for timestamp in endpoints:
            if timestamp != first_missing:
                break
            first_missing += grid.step
        report.error("missing_interval_ends", f"{path}.readings", f"{missing} accepted interval ends are missing. First gap: {first_missing.isoformat()}.")
    if rejected:
        report.warnings.append({
            "code": "rejected_qc",
            "path": f"{path}.readings",
            "message": f"Excluded {rejected} suspect, invalid or missing readings.",
        })
    return ordered
