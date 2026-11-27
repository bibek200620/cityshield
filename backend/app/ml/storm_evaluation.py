"""Pair local, authorized observations with a surveyed drainage model run."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StringConstraints, ValidationError

from app.ml.storm_import import StormEvent


NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
FiniteNumber = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Depth = Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]


class ModelRunError(ValueError):
    """The supplied model run cannot be paired with the observations."""


class ModelRunUnavailable(ModelRunError):
    """There is no model output permitted for display."""


class ModeledDepth(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timestamp: str
    depth_m: Depth


class ModeledNode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invert_elevation_m: FiniteNumber
    vertical_datum: NonEmptyText
    series: list[ModeledDepth]


class DrainageModelRun(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0.0"]
    event_id: NonEmptyText
    catchment_id: NonEmptyText
    network_id: NonEmptyText
    network_version: NonEmptyText
    quantity: Literal["drain_depth_above_invert_m"]
    name: NonEmptyText
    version: NonEmptyText
    run_reference: NonEmptyText
    source_url: HttpUrl | None = None
    reuse_terms: NonEmptyText
    allow_api_display: Annotated[bool, Field(strict=True)]
    rainfall_sha256: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    calibration_storm_groups: list[NonEmptyText]
    nodes: dict[NonEmptyText, ModeledNode]


def rainfall_fingerprint(event: StormEvent) -> str:
    """Identify normalized interval rainfall in UTC, including gauge IDs."""
    forcing = {
        gauge_id: [[timestamp.isoformat(), amount] for timestamp, amount in sorted(gauge.rainfall_mm.items())]
        for gauge_id, gauge in sorted(event.gauges.items())
    }
    canonical = json.dumps(forcing, separators=(",", ":"), sort_keys=True, allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_model_run(path: Path) -> DrainageModelRun:
    try:
        run = DrainageModelRun.model_validate_json(path.read_bytes())
    except FileNotFoundError as exc:
        raise ModelRunUnavailable("A surveyed drainage model run has not been added for this event.") from exc
    except ValidationError as exc:
        fields = ", ".join(sorted({str(error["loc"][0]) if error["loc"] else "JSON" for error in exc.errors()}))
        raise ModelRunError(f"The model run has invalid fields: {fields}.") from exc
    except OSError as exc:
        raise ModelRunError("The drainage model run could not be read.") from exc
    if not run.allow_api_display:
        raise ModelRunUnavailable("A drainage model run permitted for display is unavailable.")
    return run


def _model_series(node: ModeledNode) -> dict[datetime, float]:
    series: dict[datetime, float] = {}
    for point in node.series:
        try:
            timestamp = datetime.fromisoformat(point.timestamp)
            if timestamp.utcoffset() is None:
                raise ValueError("Timestamp has no UTC offset")
            timestamp = timestamp.astimezone(timezone.utc)
        except (ValueError, OverflowError) as exc:
            raise ModelRunError("Model depths need ISO timestamps with a UTC offset.") from exc
        if timestamp in series:
            raise ModelRunError("Model depths contain duplicate timestamps after UTC normalization.")
        series[timestamp] = point.depth_m
    return series


def _validate_holdout(event: StormEvent, run: DrainageModelRun, events: list[StormEvent]) -> None:
    if any(other.storm_group_id == event.storm_group_id and other.partition != event.partition for other in events):
        raise ModelRunError("This storm group appears in both the development and holdout partitions.")
    if event.partition != "holdout":
        return
    if event.storm_group_id in run.calibration_storm_groups:
        raise ModelRunError("The holdout storm was used to calibrate this model run.")
    development_groups = {
        other.storm_group_id for other in events
        if other.partition == "development"
        and (other.catchment_id, other.network_id, other.network_version)
        == (event.catchment_id, event.network_id, event.network_version)
        and (other.end_utc <= event.start_utc or event.end_utc <= other.start_utc)
    }
    calibrated = set(run.calibration_storm_groups)
    conflicting_groups = {other.storm_group_id for other in events if other.partition == "holdout"}
    overlapping_groups = {
        other.storm_group_id for other in events
        if other.start_utc < event.end_utc and event.start_utc < other.end_utc
    }
    if not calibrated or not calibrated <= development_groups or calibrated & (conflicting_groups | overlapping_groups):
        raise ModelRunError(
            "The holdout run needs documented, separate development storms for this network version."
        )


def _peak(timestamps: list[datetime], depths: list[float]) -> tuple[float, datetime | None]:
    maximum = max(depths)
    return maximum, timestamps[depths.index(maximum)] if maximum > 0 else None


def evaluate_storm(event: StormEvent, run: DrainageModelRun, events: list[StormEvent]) -> dict:
    if not event.source.allow_api_display or not run.allow_api_display:
        raise ModelRunUnavailable("A storm comparison permitted for display is unavailable.")
    if (run.event_id, run.catchment_id, run.network_id, run.network_version) != (
        event.event_id, event.catchment_id, event.network_id, event.network_version
    ):
        raise ModelRunError("The drainage model run does not match the event, catchment, and network version.")
    if run.rainfall_sha256 != rainfall_fingerprint(event):
        raise ModelRunError("The model run rainfall fingerprint differs from the imported observations.")
    _validate_holdout(event, run, events)

    sensors = []
    for sensor in event.sensors.values():
        node = run.nodes.get(sensor.node_id)
        if node is None:
            raise ModelRunError(f"The model run is missing a mapped node for sensor {sensor.id}.")
        if (node.invert_elevation_m, node.vertical_datum) != (sensor.invert_elevation_m, sensor.vertical_datum):
            raise ModelRunError(f"The model and sensor {sensor.id} use different drain invert references.")
        predictions = _model_series(node)
        rainfall = event.gauges[sensor.gauge_id].rainfall_mm
        timestamps = sorted(rainfall)
        prediction_ends = predictions.keys() - {event.start_utc}
        if prediction_ends != rainfall.keys() or not rainfall.keys() <= sensor.levels_m.keys():
            raise ModelRunError(f"Sensor {sensor.id} needs matched depths at every rainfall interval.")

        observed = [sensor.levels_m[t] for t in timestamps]
        modeled = [predictions[t] for t in timestamps]
        observed_peak, observed_at = _peak(timestamps, observed)
        modeled_peak, modeled_at = _peak(timestamps, modeled)
        sensors.append({
            "id": sensor.id,
            "name": None,
            "node_id": sensor.node_id,
            "gauge_id": sensor.gauge_id,
            "latitude": sensor.lat,
            "longitude": sensor.lng,
            "series": [{
                "timestamp": timestamp.isoformat(),
                "rainfall_mm": rainfall[timestamp],
                "observed_depth_m": actual,
                "modeled_depth_m": prediction,
            } for timestamp, actual, prediction in zip(timestamps, observed, modeled, strict=True)],
            "metrics": {
                "sample_count": len(timestamps),
                "mae_m": fmean(abs(actual - prediction) for actual, prediction in zip(observed, modeled, strict=True)),
                "observed_peak_m": observed_peak,
                "modeled_peak_m": modeled_peak,
                "observed_peak_at": observed_at.isoformat() if observed_at else None,
                "modeled_peak_at": modeled_at.isoformat() if modeled_at else None,
                "peak_timing_error_minutes": (modeled_at - observed_at).total_seconds() / 60
                if observed_at and modeled_at else None,
            },
        })

    partition_note = (
        "This event was held out from the development storms declared with the model run."
        if event.partition == "holdout" else "Development results describe this storm and do not measure holdout performance."
    )
    return {
        "status": "ready",
        "event_id": event.event_id,
        "storm_group_id": event.storm_group_id,
        "catchment_id": event.catchment_id,
        "partition": event.partition,
        "network_id": event.network_id,
        "network_version": event.network_version,
        "interval_minutes": event.interval_minutes,
        "model": {
            "name": run.name,
            "version": run.version,
            "source_url": str(run.source_url) if run.source_url else None,
            "run_reference": run.run_reference,
        },
        "observation_source": {"title": event.source.title, "url": event.source.url},
        "sensors": sensors,
        "limitations": [
            "Depth is measured above the shared drain invert. Rainfall is the matched gauge's interval total.",
            "Tied positive peaks use the first occurrence. An all-zero series has no peak time.",
            partition_note,
        ],
    }
