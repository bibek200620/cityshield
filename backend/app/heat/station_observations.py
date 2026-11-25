"""Validation and daily aggregation for one NOAA GHCNh station archive.

This module handles observed point-station records, not gridded reanalysis,
satellite land-surface temperature, or an operational city forecast.
"""
from __future__ import annotations

import csv
import hashlib
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

STATION_ID = "INM00043296"
STATION_NAME = "BANGALORE/HINDUSTAN AIRPORT"
SOURCE_STATION_ID = "ICAO-VOBG"
STATION_LATITUDE = 12.95
STATION_LONGITUDE = 77.6333
STATION_ELEVATION_M = 888
SOURCE_CODE = "223"
TIMEZONE = "Asia/Kolkata"
MIN_DAILY_REPORTS = 8
MIN_DAILY_SPAN_HOURS = 18.0
REQUIRED_COLUMNS = {
    "STATION", "Station_name", "DATE", "LATITUDE", "LONGITUDE",
    "temperature", "temperature_Quality_Code", "temperature_Source_Code",
    "temperature_Source_Station_ID", "relative_humidity",
    "relative_humidity_Measurement_Code", "relative_humidity_Quality_Code",
    "relative_humidity_Source_Code", "relative_humidity_Source_Station_ID",
}
DAILY_COLUMNS = (
    "tmax_c", "tmean_c", "tmin_c", "rh_mean_pct", "rh_max_pct", "rh_min_pct",
    "paired_report_count", "coverage_span_hours",
)


class StationDataError(ValueError):
    """Raised when a GHCNh station file violates its expected data contract."""


def _number(raw: str, label: str) -> float | None:
    value = raw.strip()
    if not value or value.lower() in {"null", "nan"}:
        return None
    try:
        parsed = float(value)
    except ValueError as exc:
        raise StationDataError(f"{label} must be numeric when present") from exc
    if not np.isfinite(parsed):
        raise StationDataError(f"{label} must be finite")
    return parsed


def load_paired_observations(path: Path) -> tuple[pd.DataFrame, dict]:
    """Read only this station's quality-accepted temperature and derived RH.

    GHCNh timestamps are UTC. Temperature source 223 is retained only with QC
    flag 1. RH must be derived (measurement code D) by source 223; reported RH
    flags f/o and any unrecognized non-empty flag are rejected.
    """
    if not path.is_file():
        raise StationDataError(f"GHCNh station file not found: {path}")
    rows: list[tuple[datetime, float, float]] = []
    counts: Counter[str] = Counter()
    timestamps: set[datetime] = set()
    first_timestamp: datetime | None = None
    last_timestamp: datetime | None = None
    previous_timestamp: datetime | None = None
    sha = hashlib.sha256()
    with path.open("rb") as raw_file:
        for chunk in iter(lambda: raw_file.read(1024 * 1024), b""):
            sha.update(chunk)

    with path.open(newline="", encoding="utf-8") as source:
        reader = csv.DictReader(source, delimiter="|")
        if reader.fieldnames is None or not REQUIRED_COLUMNS.issubset(reader.fieldnames):
            missing = sorted(REQUIRED_COLUMNS - set(reader.fieldnames or []))
            raise StationDataError(f"GHCNh header is missing required fields: {missing}")
        counts["raw_rows"] = 0
        for row_number, row in enumerate(reader, start=2):
            counts["raw_rows"] += 1
            if None in row or any(value is None for value in row.values()):
                raise StationDataError(f"GHCNh row {row_number} does not match the header field count")
            if row.get("STATION") != STATION_ID:
                raise StationDataError(f"GHCNh row {row_number} is not station {STATION_ID}")
            if row.get("Station_name") != STATION_NAME:
                raise StationDataError(f"GHCNh row {row_number} has an unexpected station name")
            try:
                latitude = float(row["LATITUDE"])
                longitude = float(row["LONGITUDE"])
            except (TypeError, ValueError) as exc:
                raise StationDataError(f"GHCNh row {row_number} has invalid station coordinates") from exc
            if not (np.isclose(latitude, STATION_LATITUDE) and np.isclose(longitude, STATION_LONGITUDE)):
                raise StationDataError(f"GHCNh row {row_number} station coordinates changed unexpectedly")
            try:
                timestamp = datetime.fromisoformat(row["DATE"].strip())
            except (TypeError, ValueError) as exc:
                raise StationDataError(f"GHCNh row {row_number} has an invalid DATE") from exc
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            else:
                timestamp = timestamp.astimezone(timezone.utc)
            if timestamp in timestamps:
                raise StationDataError(f"Duplicate GHCNh timestamp at row {row_number}: {timestamp.isoformat()}")
            if previous_timestamp is not None and timestamp < previous_timestamp:
                raise StationDataError(f"GHCNh timestamps are out of order at row {row_number}")
            timestamps.add(timestamp)
            if first_timestamp is None:
                first_timestamp = timestamp
            previous_timestamp = timestamp
            last_timestamp = timestamp

            if row["temperature_Source_Code"] != SOURCE_CODE:
                counts["excluded_temperature_source"] += 1
                continue
            if row["temperature_Source_Station_ID"] != SOURCE_STATION_ID:
                counts["excluded_temperature_source_station"] += 1
                continue
            if row["temperature_Quality_Code"] != "1":
                counts["excluded_temperature_quality"] += 1
                continue
            temperature = _number(row["temperature"], "temperature")
            if temperature is None:
                counts["missing_temperature"] += 1
                continue
            if not -50 <= temperature <= 65:
                raise StationDataError(f"GHCNh row {row_number} temperature is outside [-50, 65] °C")

            if row["relative_humidity_Source_Code"] != SOURCE_CODE:
                counts["excluded_humidity_source"] += 1
                continue
            if row["relative_humidity_Source_Station_ID"] != SOURCE_STATION_ID:
                counts["excluded_humidity_source_station"] += 1
                continue
            if row["relative_humidity_Measurement_Code"] != "D":
                counts["excluded_humidity_not_derived"] += 1
                continue
            humidity_qc = row["relative_humidity_Quality_Code"].strip().lower()
            if humidity_qc in {"f", "o"}:
                counts[f"excluded_humidity_quality_{humidity_qc}"] += 1
                continue
            if humidity_qc:
                raise StationDataError(f"GHCNh row {row_number} has unknown RH quality flag {humidity_qc!r}")
            humidity = _number(row["relative_humidity"], "relative humidity")
            if humidity is None:
                counts["missing_humidity"] += 1
                continue
            if not 0 <= humidity <= 100:
                raise StationDataError(f"GHCNh row {row_number} relative humidity is outside [0, 100] %")
            rows.append((timestamp, temperature, humidity))

    if not rows:
        raise StationDataError("No quality-accepted paired temperature/RH reports were found")
    observations = pd.DataFrame(
        rows,
        columns=("time_utc", "temperature_c", "relative_humidity_pct"),
    ).set_index("time_utc").sort_index()
    counts["paired_quality_accepted_reports"] = len(observations)
    metadata = {
        "source": "NOAA NCEI Global Historical Climatology Network hourly (GHCNh)",
        "source_url": "https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-station/GHCNh_INM00043296_por.psv",
        "doi": "https://doi.org/10.25921/jp3d-3v19",
        "station_id": STATION_ID,
        "station_name": STATION_NAME,
        "source_station_id": SOURCE_STATION_ID,
        "latitude": STATION_LATITUDE,
        "longitude": STATION_LONGITUDE,
        "elevation_m": STATION_ELEVATION_M,
        "provenance_class": "observed_station_data; relative humidity is derived from station observations",
        "source_temperature_code": SOURCE_CODE,
        "temperature_quality_rule": "temperature source 223, matching source station ICAO-VOBG, QC flag 1",
        "humidity_quality_rule": "RH source 223, matching source station ICAO-VOBG, measurement code D; reject QC f/o",
        "raw_file_sha256": sha.hexdigest(),
        "raw_rows": counts["raw_rows"],
        "raw_start_utc": first_timestamp.isoformat() if first_timestamp else None,
        "raw_end_utc": last_timestamp.isoformat() if last_timestamp else None,
        "paired_observation_start_utc": observations.index.min().isoformat(),
        "paired_observation_end_utc": observations.index.max().isoformat(),
        "quality_accepted_reports": len(observations),
        "row_quality_counts": dict(sorted(counts.items())),
    }
    return observations, metadata


def aggregate_local_days(
    observations: pd.DataFrame,
    *,
    min_reports: int = MIN_DAILY_REPORTS,
    min_span_hours: float = MIN_DAILY_SPAN_HOURS,
) -> tuple[pd.DataFrame, dict]:
    """Aggregate paired reports; exclude incomplete local days without filling."""
    required = {"temperature_c", "relative_humidity_pct"}
    if not isinstance(observations, pd.DataFrame) or not required.issubset(observations.columns):
        raise StationDataError("Paired observations must have temperature_c and relative_humidity_pct columns")
    if observations.empty:
        raise StationDataError("Paired observations are empty")
    if not isinstance(observations.index, pd.DatetimeIndex) or observations.index.tz is None:
        raise StationDataError("Observation timestamps must have a timezone")
    values = observations.loc[:, ["temperature_c", "relative_humidity_pct"]].astype(float)
    if not np.isfinite(values.to_numpy()).all():
        raise StationDataError("Paired observations must be finite")
    if ((values["relative_humidity_pct"] < 0) | (values["relative_humidity_pct"] > 100)).any():
        raise StationDataError("Relative humidity must be within [0, 100] %")
    if min_reports < 1 or min_span_hours <= 0:
        raise StationDataError("Daily coverage thresholds must be positive")

    local = values.copy()
    local.index = local.index.tz_convert(TIMEZONE)
    local["local_date"] = local.index.date
    accepted: list[dict] = []
    excluded = 0
    for day, group in local.groupby("local_date", sort=True):
        span = (group.index.max() - group.index.min()).total_seconds() / 3600
        if len(group) < min_reports or span < min_span_hours:
            excluded += 1
            continue
        accepted.append({
            "date": pd.Timestamp(day, tz=TIMEZONE),
            "tmax_c": float(group["temperature_c"].max()),
            "tmean_c": float(group["temperature_c"].mean()),
            "tmin_c": float(group["temperature_c"].min()),
            "rh_mean_pct": float(group["relative_humidity_pct"].mean()),
            "rh_max_pct": float(group["relative_humidity_pct"].max()),
            "rh_min_pct": float(group["relative_humidity_pct"].min()),
            "paired_report_count": int(len(group)),
            "coverage_span_hours": float(span),
        })
    if not accepted:
        raise StationDataError("No local dates meet the paired-report count and time-span requirements")
    daily = pd.DataFrame(accepted).set_index("date").sort_index()
    if tuple(daily.columns) != DAILY_COLUMNS:
        raise StationDataError("Daily feature schema does not match the declared order")
    quality = {
        "candidate_local_days": int(local["local_date"].nunique()),
        "eligible_local_days": int(len(daily)),
        "excluded_incomplete_local_days": int(excluded),
        "min_paired_reports": int(min_reports),
        "min_coverage_span_hours": float(min_span_hours),
        "eligible_day_start": daily.index.min().date().isoformat(),
        "eligible_day_end": daily.index.max().date().isoformat(),
    }
    return daily, quality


def build_next_day_dataset(daily: pd.DataFrame) -> pd.DataFrame:
    """Create next-local-day Tmax examples only for adjacent eligible dates."""
    if not isinstance(daily, pd.DataFrame) or tuple(daily.columns) != DAILY_COLUMNS:
        raise StationDataError("Daily observations do not match the validated feature schema")
    if not isinstance(daily.index, pd.DatetimeIndex) or daily.index.tz is None or str(daily.index.tz) != TIMEZONE:
        raise StationDataError(f"Daily timestamps must use {TIMEZONE}")
    ordered = daily.sort_index()
    records = []
    for previous_date, target_date in zip(ordered.index[:-1], ordered.index[1:]):
        if target_date - previous_date != pd.Timedelta(days=1):
            continue
        target_doy = target_date.dayofyear
        records.append({
            "target_date": target_date,
            "previous_tmax_c": ordered.at[previous_date, "tmax_c"],
            "previous_tmean_c": ordered.at[previous_date, "tmean_c"],
            "previous_tmin_c": ordered.at[previous_date, "tmin_c"],
            "previous_rh_mean_pct": ordered.at[previous_date, "rh_mean_pct"],
            "previous_rh_max_pct": ordered.at[previous_date, "rh_max_pct"],
            "previous_rh_min_pct": ordered.at[previous_date, "rh_min_pct"],
            "target_doy_sin": float(np.sin(2 * np.pi * target_doy / 365.25)),
            "target_doy_cos": float(np.cos(2 * np.pi * target_doy / 365.25)),
            "target_tmax_c": ordered.at[target_date, "tmax_c"],
        })
    columns = [
        "previous_tmax_c", "previous_tmean_c", "previous_tmin_c",
        "previous_rh_mean_pct", "previous_rh_max_pct", "previous_rh_min_pct",
        "target_doy_sin", "target_doy_cos", "target_tmax_c",
    ]
    examples = pd.DataFrame(records, columns=["target_date", *columns])
    if examples.empty:
        raise StationDataError("No adjacent eligible local dates are available for next-day evaluation")
    return examples.set_index("target_date").sort_index()
