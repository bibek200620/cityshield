"""Download and validate Bengaluru ERA5-Land historical weather inputs.

This module handles reanalysis inputs for a research baseline only. It does not
produce observed station records or an operational heatwave forecast.
"""
from __future__ import annotations

import json
import math
import time
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
SOURCE = "Open-Meteo Historical Weather API / ERA5-Land reanalysis"
LICENSE = "CC BY 4.0"
TIMEZONE = "Asia/Kolkata"
MODEL = "era5_land"
REQUESTED_LATITUDE = 12.9716
REQUESTED_LONGITUDE = 77.5946
REQUIRED_ARCHIVE_YEARS = tuple(range(1999, 2026))
HOURLY_FIELDS = ("temperature_2m", "relative_humidity_2m")
FEATURE_COLUMNS = (
    "previous_tmax_c",
    "previous_tmean_c",
    "previous_tmin_c",
    "previous_rh_mean_pct",
    "previous_rh_max_pct",
    "previous_rh_min_pct",
    "target_doy_sin",
    "target_doy_cos",
)


class ReanalysisDataError(ValueError):
    """Raised when an archive payload or cached year violates its data contract."""


def _validate_retrieved_at(value: object, year: int) -> None:
    try:
        retrieved = datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ReanalysisDataError(f"Cached {year} response has no valid retrieval timestamp") from exc
    if retrieved.tzinfo is None or retrieved.utcoffset().total_seconds() != 0:
        raise ReanalysisDataError(f"Cached {year} retrieval timestamp must be UTC")


def archive_params(year: int) -> dict[str, str | int | float]:
    if not 1950 <= year <= 2100:
        raise ReanalysisDataError("ERA5-Land year must be between 1950 and 2100")
    return {
        "latitude": REQUESTED_LATITUDE,
        "longitude": REQUESTED_LONGITUDE,
        "start_date": f"{year}-01-01",
        "end_date": f"{year}-12-31",
        "hourly": ",".join(HOURLY_FIELDS),
        "temperature_unit": "celsius",
        "timezone": TIMEZONE,
        "timeformat": "iso8601",
        "cell_selection": "land",
        "models": MODEL,
    }


def validate_archive_payload(payload: dict, year: int) -> pd.DataFrame:
    """Validate response identity, units and exact local hourly coverage."""
    if not isinstance(payload, dict) or payload.get("error"):
        raise ReanalysisDataError("Archive response is not a successful JSON object")
    if payload.get("timezone") != TIMEZONE:
        raise ReanalysisDataError("Archive response timezone does not match Asia/Kolkata")
    try:
        utc_offset = float(payload.get("utc_offset_seconds", float("nan")))
    except (TypeError, ValueError) as exc:
        raise ReanalysisDataError("Archive response has no valid timezone offset") from exc
    if not math.isclose(utc_offset, 19800):
        raise ReanalysisDataError("Archive response has an unexpected timezone offset")
    try:
        latitude = float(payload["latitude"])
        longitude = float(payload["longitude"])
        elevation = float(payload["elevation"])
        units = payload["hourly_units"]
        hourly = payload["hourly"]
        times = hourly["time"]
        temperatures = hourly["temperature_2m"]
        humidity = hourly["relative_humidity_2m"]
    except (KeyError, TypeError, ValueError) as exc:
        raise ReanalysisDataError("Archive response is missing required location or hourly fields") from exc
    if not all(math.isfinite(value) for value in (latitude, longitude, elevation)):
        raise ReanalysisDataError("Archive grid metadata must be finite")
    if not isinstance(units, dict) or units.get("temperature_2m") != "°C" or units.get("relative_humidity_2m") != "%":
        raise ReanalysisDataError("Archive units must be temperature °C and relative humidity %")
    if not isinstance(times, list) or len(times) != len(temperatures) or len(times) != len(humidity):
        raise ReanalysisDataError("Archive hourly arrays must be present and aligned")

    expected_start = datetime(year, 1, 1)
    expected_count = (date(year + 1, 1, 1) - date(year, 1, 1)).days * 24
    if len(times) != expected_count:
        raise ReanalysisDataError(f"Archive year {year} has {len(times)} hours; expected {expected_count}")
    try:
        parsed = [datetime.fromisoformat(value) for value in times]
    except (TypeError, ValueError) as exc:
        raise ReanalysisDataError("Archive timestamps must be ISO-8601 local times") from exc
    if any(value.tzinfo is not None for value in parsed):
        raise ReanalysisDataError("Archive timestamps must match the requested local-time format")
    if parsed[0] != expected_start or any(
        current - previous != pd.Timedelta(hours=1)
        for previous, current in zip(parsed, parsed[1:])
    ):
        raise ReanalysisDataError(f"Archive timestamps are not a continuous hourly series for {year}")
    if parsed[-1].year != year or parsed[-1].month != 12 or parsed[-1].day != 31 or parsed[-1].hour != 23:
        raise ReanalysisDataError(f"Archive timestamps do not cover the end of {year}")

    def numeric_or_missing(value: object, label: str) -> float:
        if value is None:
            return float("nan")
        try:
            parsed_value = float(value)
        except (TypeError, ValueError) as exc:
            raise ReanalysisDataError(f"Archive {label} values must be numeric or null") from exc
        if not math.isfinite(parsed_value):
            return float("nan")
        if label == "relative humidity" and not 0 <= parsed_value <= 100:
            raise ReanalysisDataError("Archive relative humidity must be between 0 and 100 %")
        if label == "temperature" and not -50 <= parsed_value <= 65:
            raise ReanalysisDataError("Archive temperature is outside the supported physical range")
        return parsed_value

    return pd.DataFrame(
        {
            "temperature_2m_c": [numeric_or_missing(value, "temperature") for value in temperatures],
            "relative_humidity_2m_pct": [numeric_or_missing(value, "relative humidity") for value in humidity],
        },
        index=pd.DatetimeIndex(parsed, tz=TIMEZONE, name="time"),
    )


def fetch_archive_year(year: int, *, timeout: float = 30.0) -> dict:
    params = urlencode(archive_params(year))
    request = Request(
        f"{ARCHIVE_URL}?{params}",
        headers={"User-Agent": "CityShield-research/0.1 (ERA5-Land reproducibility workflow)"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ReanalysisDataError(f"ERA5-Land archive request failed for {year}: {exc}") from exc


def download_archive(
    data_dir: Path,
    *,
    start_year: int = 1999,
    end_year: int = 2025,
    request_interval_s: float = 0.25,
) -> list[Path]:
    """Download/cache annual payloads, validating before each atomic cache write."""
    if start_year > end_year:
        raise ReanalysisDataError("start_year must not exceed end_year")
    data_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for year in range(start_year, end_year + 1):
        target = data_dir / f"era5-land-{year}.json"
        if target.exists():
            cached = json.loads(target.read_text())
            if not isinstance(cached, dict) or cached.get("request") != archive_params(year) or "response" not in cached:
                raise ReanalysisDataError(
                    f"Cached {year} response lacks the exact ERA5-Land request manifest; "
                    "preserve it and download a verified cache before training"
                )
            _validate_retrieved_at(cached.get("retrieved_at_utc"), year)
            validate_archive_payload(cached["response"], year)
            paths.append(target)
            continue
        if paths and request_interval_s > 0:
            time.sleep(request_interval_s)
        payload = fetch_archive_year(year)
        validate_archive_payload(payload, year)
        cache = {
            "request": archive_params(year),
            "retrieved_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "response": payload,
        }
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(cache, separators=(",", ":")) + "\n")
        temporary.replace(target)
        paths.append(target)
        print(f"Downloaded and validated ERA5-Land {year}", flush=True)
    return paths


def load_archive(paths: list[Path]) -> tuple[pd.DataFrame, dict]:
    """Load validated annual JSON payloads and report the exact selected grid."""
    frames = []
    grid_cells = set()
    years = []
    requests = []
    for path in sorted(paths):
        cached = json.loads(path.read_text())
        year = int(path.stem.rsplit("-", 1)[1])
        expected_request = archive_params(year)
        if not isinstance(cached, dict) or cached.get("request") != expected_request or "response" not in cached:
            raise ReanalysisDataError(f"Cached {year} response has no matching ERA5-Land request manifest")
        _validate_retrieved_at(cached.get("retrieved_at_utc"), year)
        payload = cached["response"]
        frame = validate_archive_payload(payload, year)
        frames.append(frame)
        years.append(year)
        requests.append({"year": year, "parameters": expected_request, "retrieved_at_utc": cached.get("retrieved_at_utc")})
        grid_cells.add((float(payload["latitude"]), float(payload["longitude"]), float(payload["elevation"])))
    if not frames or len(years) != len(set(years)):
        raise ReanalysisDataError("At least one unique annual ERA5-Land file is required")
    if len(grid_cells) != 1:
        raise ReanalysisDataError("ERA5-Land annual files do not refer to a consistent grid cell")
    hourly = pd.concat(frames).sort_index()
    if hourly.index.has_duplicates or not hourly.index.is_monotonic_increasing:
        raise ReanalysisDataError("ERA5-Land annual files overlap or are out of order")
    latitude, longitude, elevation = next(iter(grid_cells))
    return hourly, {
        "source": SOURCE,
        "provenance_class": "reanalysis_model_derived",
        "model": MODEL,
        "license": LICENSE,
        "requested_location": {"latitude": REQUESTED_LATITUDE, "longitude": REQUESTED_LONGITUDE},
        "grid_cell": {"latitude": latitude, "longitude": longitude, "elevation_m": elevation},
        "timezone": TIMEZONE,
        "hourly_units": {"temperature_2m": "°C", "relative_humidity_2m": "%"},
        "start_year": min(years),
        "end_year": max(years),
        "years": sorted(years),
        "archive_requests": requests,
        "spatial_resolution": "0.1° (~11 km; provider documentation)",
        "retrieved_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "missing_hour_values": int(hourly.isna().any(axis=1).sum()),
    }


def daily_weather(hourly: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Aggregate only complete local days; missing hours are excluded transparently."""
    required = {"temperature_2m_c", "relative_humidity_2m_pct"}
    if not required <= set(hourly.columns) or not isinstance(hourly.index, pd.DatetimeIndex):
        raise ReanalysisDataError("Hourly frame must contain validated ERA5-Land fields and timestamps")
    if hourly.index.tz is None:
        raise ReanalysisDataError("Hourly timestamps must have an explicit local timezone")
    if hourly.index.tz.zone != TIMEZONE:
        raise ReanalysisDataError("Hourly timestamps must use Asia/Kolkata")
    grouped = hourly.resample("D")
    temperature = grouped["temperature_2m_c"].agg(["max", "mean", "min"])
    humidity = grouped["relative_humidity_2m_pct"].agg(["mean", "max", "min"])
    counts = grouped.size()
    valid_temperature_count = grouped["temperature_2m_c"].count()
    valid_humidity_count = grouped["relative_humidity_2m_pct"].count()
    daily = pd.DataFrame(
        {
            "tmax_c": temperature["max"],
            "tmean_c": temperature["mean"],
            "tmin_c": temperature["min"],
            "rh_mean_pct": humidity["mean"],
            "rh_max_pct": humidity["max"],
            "rh_min_pct": humidity["min"],
        }
    )
    complete = (counts == 24) & (valid_temperature_count == 24) & (valid_humidity_count == 24)
    daily = daily.loc[complete].dropna()
    return daily, {
        "calendar_days": int(len(counts)),
        "complete_days": int(len(daily)),
        "excluded_incomplete_days": int((~complete).sum()),
    }


def build_next_day_dataset(daily: pd.DataFrame) -> pd.DataFrame:
    """Pair target date with preceding-day features; never forward-fill gaps."""
    rows = []
    for target_date, target_row in daily.iterrows():
        previous_date = target_date - pd.Timedelta(days=1)
        if previous_date not in daily.index:
            continue
        previous = daily.loc[previous_date]
        day_of_year = target_date.dayofyear
        angle = 2 * math.pi * (day_of_year - 1) / 366
        rows.append(
            {
                "target_date": target_date,
                "previous_tmax_c": previous["tmax_c"],
                "previous_tmean_c": previous["tmean_c"],
                "previous_tmin_c": previous["tmin_c"],
                "previous_rh_mean_pct": previous["rh_mean_pct"],
                "previous_rh_max_pct": previous["rh_max_pct"],
                "previous_rh_min_pct": previous["rh_min_pct"],
                "target_doy_sin": math.sin(angle),
                "target_doy_cos": math.cos(angle),
                "target_doy": day_of_year,
                "target_tmax_c": target_row["tmax_c"],
            }
        )
    if not rows:
        raise ReanalysisDataError("No adjacent complete local days are available for next-day targets")
    result = pd.DataFrame(rows).set_index("target_date").sort_index()
    values = result[list(FEATURE_COLUMNS) + ["target_tmax_c"]].to_numpy(dtype=float)
    if not all(math.isfinite(value) for value in values.ravel()):
        raise ReanalysisDataError("Training examples contain missing or non-finite values")
    return result
