"""India-wide weather samples from NOAA's public GFS 0.25 degree GRIB2 data."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import logging
from math import ceil, isfinite
from threading import Lock
from time import time
from urllib.parse import urlencode

import numpy as np
import rasterio
import requests
from rasterio.io import MemoryFile

logger = logging.getLogger("uvicorn.error")
NOMADS_FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
GRID_CACHE_SECONDS = 3 * 60 * 60
MAX_STALE_SECONDS = 12 * 60 * 60
_cache_lock = Lock()
_refresh_lock = Lock()


@dataclass
class ForecastGrid:
    temperature_c: np.ndarray
    rainfall_24h_mm: np.ndarray
    feels_like_c: np.ndarray | None
    relative_humidity_pct: np.ndarray | None
    wind_speed_kmh: np.ndarray | None
    transform: rasterio.Affine
    crs: rasterio.crs.CRS
    model_run: datetime
    valid_start: datetime
    valid_end: datetime
    retrieved_at: str


_cached_grid: ForecastGrid | None = None
_cached_at = 0.0


def _grib_url(model_run: datetime, forecast_hour: int) -> str:
    cycle = model_run.strftime("%H")
    filename = f"gfs.t{cycle}z.pgrb2.0p25.f{forecast_hour:03d}"
    params = {
        "file": filename,
        "lev_2_m_above_ground": "on",
        "lev_10_m_above_ground": "on",
        "lev_surface": "on",
        "var_TMP": "on",
        "var_RH": "on",
        "var_UGRD": "on",
        "var_VGRD": "on",
        "var_APCP": "on",
        "subregion": "",
        "leftlon": "68",
        "rightlon": "98",
        "toplat": "38",
        "bottomlat": "6",
        "dir": f"/gfs.{model_run:%Y%m%d}/{cycle}/atmos",
    }
    return f"{NOMADS_FILTER_URL}?{urlencode(params)}"


def _download_grib(model_run: datetime, forecast_hour: int) -> bytes:
    response = requests.get(_grib_url(model_run, forecast_hour), timeout=(5, 15))
    response.raise_for_status()
    content = response.content
    if len(content) < 100 or not content.startswith(b"GRIB"):
        raise ValueError("NOAA returned an empty or non-GRIB response")
    return content


def _read_fields(content: bytes) -> tuple[dict[str, np.ndarray], rasterio.Affine, rasterio.crs.CRS]:
    with rasterio.Env(GRIB_NORMALIZE_UNITS="YES"), MemoryFile(content) as memory_file:
        with memory_file.open() as dataset:
            bands: dict[str, int] = {}
            for band in range(1, dataset.count + 1):
                tags = dataset.tags(band)
                element = str(tags.get("GRIB_ELEMENT", "")).upper()
                short_name = str(tags.get("GRIB_SHORT_NAME", "")).upper()
                description = str(dataset.descriptions[band - 1] or "").lower()
                level_tags = " ".join((short_name, description, str(tags.get("GRIB_COMMENT", "")))).lower()
                is_2m = "2-htgl" in short_name or "2[m]" in description or "2 m above ground" in level_tags
                is_10m = "10-htgl" in short_name or "10[m]" in description or "10 m above ground" in level_tags
                key = None
                if element == "TMP" and is_2m:
                    key = "temperature"
                elif element == "RH" and is_2m:
                    key = "humidity"
                elif element == "UGRD" and is_10m:
                    key = "wind_u"
                elif element == "VGRD" and is_10m:
                    key = "wind_v"
                elif element.startswith("APCP") and "precipitation" in level_tags:
                    key = "precipitation"
                if key and key not in bands:
                    bands[key] = band
            if "temperature" not in bands or "precipitation" not in bands or dataset.crs is None:
                raise ValueError("NOAA GRIB is missing 2 m temperature or surface precipitation")

            temp_tags = dataset.tags(bands["temperature"])
            rain_tags = dataset.tags(bands["precipitation"])
            temp_unit = str(temp_tags.get("GRIB_UNIT", "")).lower().strip("[]")
            rain_unit = str(rain_tags.get("GRIB_UNIT", "")).lower().strip("[]")
            # GDAL's GRIB driver normalizes temperature values to Celsius by
            # default, even though GRIB_UNIT metadata may retain the source K.
            if temp_unit and temp_unit not in {"k", "kelvin", "c", "°c", "deg c", "celsius"}:
                raise ValueError("NOAA temperature unit is not recognized")
            if rain_unit and not any(token in rain_unit for token in ("kg", "mm", "m-2", "m**-2", "m^2")):
                raise ValueError("NOAA precipitation unit is not recognized")
            rain_comment = str(rain_tags.get("GRIB_COMMENT", "")).lower()
            if "precipitation" not in rain_comment or "6 hr" not in rain_comment:
                raise ValueError("NOAA precipitation band is not a six-hour accumulation")
            fields: dict[str, np.ndarray] = {}
            for name, band in bands.items():
                array = dataset.read(band).astype("float32")
                if name == "temperature":
                    array[array < -100] = np.nan
                elif name == "precipitation":
                    array[array < 0] = np.nan
                elif name == "humidity":
                    array[(array < 0) | (array > 100)] = np.nan
                elif name.startswith("wind_"):
                    array[np.abs(array) > 150] = np.nan
                fields[name] = array
            if "wind_u" in fields and "wind_v" in fields:
                fields["wind_speed_kmh"] = np.hypot(fields["wind_u"], fields["wind_v"]) * 3.6
            if all(key in fields for key in ("temperature", "humidity", "wind_speed_kmh")):
                temp = fields["temperature"]
                vapor_pressure = (fields["humidity"] / 100) * 6.105 * np.exp(17.27 * temp / (237.7 + temp))
                fields["feels_like"] = temp + 0.33 * vapor_pressure - 0.70 * (fields["wind_speed_kmh"] / 3.6) - 4.0
            return fields, dataset.transform, dataset.crs


def _model_run_candidates(now: datetime) -> list[tuple[datetime, int]]:
    latest_cycle_hour = (now.hour // 6) * 6
    latest_cycle = now.replace(hour=latest_cycle_hour, minute=0, second=0, microsecond=0)
    candidates: list[tuple[datetime, int]] = []
    for offset in range(0, 12, 6):
        cycle = latest_cycle - timedelta(hours=offset)
        lead = max(6, ceil((now - cycle).total_seconds() / 21_600) * 6)
        if lead + 24 <= 384:
            candidates.append((cycle, lead))
    return candidates


def _load_grid(now: datetime) -> ForecastGrid:
    last_error: Exception | None = None
    for model_run, lead_start in _model_run_candidates(now):
        try:
            lead_end = lead_start + 24
            forecast_hours = [lead_start, *range(lead_start + 6, lead_end + 1, 6)]
            with ThreadPoolExecutor(max_workers=3) as executor:
                contents = list(executor.map(
                    lambda forecast_hour: _download_grib(model_run, forecast_hour), forecast_hours,
                ))
            start_fields, affine, crs = _read_fields(contents[0])
            temperature = start_fields["temperature"]
            six_hour_rain = []
            for content in contents[1:]:
                fields, rain_affine, rain_crs = _read_fields(content)
                precipitation = fields["precipitation"]
                if rain_affine != affine or rain_crs != crs or precipitation.shape != temperature.shape:
                    raise ValueError("NOAA forecast fields do not share a grid")
                six_hour_rain.append(precipitation)
            rain_stack = np.stack(six_hour_rain)
            complete_precipitation = np.all(np.isfinite(rain_stack), axis=0)
            rainfall_24h = np.sum(rain_stack, axis=0)
            rainfall_24h[~complete_precipitation] = np.nan
            valid_start = model_run + timedelta(hours=lead_start)
            valid_end = model_run + timedelta(hours=lead_end)
            return ForecastGrid(
                temperature_c=temperature,
                rainfall_24h_mm=rainfall_24h,
                feels_like_c=start_fields.get("feels_like"),
                relative_humidity_pct=start_fields.get("humidity"),
                wind_speed_kmh=start_fields.get("wind_speed_kmh"),
                transform=affine,
                crs=crs,
                model_run=model_run,
                valid_start=valid_start,
                valid_end=valid_end,
                retrieved_at=datetime.now(timezone.utc).isoformat(),
            )
        except (requests.RequestException, rasterio.errors.RasterioError, ValueError, OSError) as exc:
            last_error = exc
            logger.info("NOAA GFS cycle unavailable (run=%s, lead=%s, error=%s)",
                        model_run.isoformat(), lead_start, type(exc).__name__)
    raise RuntimeError("No recent NOAA GFS forecast grid is available") from last_error


def _get_grid(now: datetime) -> tuple[ForecastGrid, bool]:
    global _cached_grid, _cached_at
    current = time()
    with _cache_lock:
        if _cached_grid and current - _cached_at < GRID_CACHE_SECONDS:
            return _cached_grid, False
    with _refresh_lock:
        current = time()
        with _cache_lock:
            if _cached_grid and current - _cached_at < GRID_CACHE_SECONDS:
                return _cached_grid, False
        try:
            grid = _load_grid(now)
        except RuntimeError:
            with _cache_lock:
                if _cached_grid and current - _cached_at <= MAX_STALE_SECONDS:
                    return _cached_grid, True
            raise
        with _cache_lock:
            _cached_grid = grid
            _cached_at = time()
        return grid, False


def _sample_row_col(grid: ForecastGrid, lat: float, lng: float) -> tuple[int, int]:
    if not grid.crs.is_geographic:
        raise ValueError("NOAA weather grid is not geographic")
    # GDAL's GRIB WKT advertises latitude as axis 1; raster affine coordinates
    # remain x=longitude, y=latitude. Pass the affine in that native order.
    row, col = rasterio.transform.rowcol(grid.transform, lng, lat)
    return int(row), int(col)


def get_national_weather_grid(locations: list[dict]) -> tuple[list[dict], int]:
    """Sample one cached national GFS grid for the requested visible hex centers."""
    try:
        grid, stale = _get_grid(datetime.now(timezone.utc))
    except RuntimeError:
        return [], len(locations)

    results: list[dict] = []
    rows, columns = grid.temperature_c.shape
    for point in locations:
        try:
            row, col = _sample_row_col(grid, point["lat"], point["lng"])
            if not (0 <= row < rows and 0 <= col < columns):
                continue
            temperature = float(grid.temperature_c[row, col])
            rain_24h = float(grid.rainfall_24h_mm[row, col])
            if not all(isfinite(value) for value in (temperature, rain_24h)):
                continue
            if rain_24h < -0.01:
                continue
            rain_24h = max(0.0, rain_24h)
            optional_value = lambda values: (  # noqa: E731 - small local raster sampler
                round(float(values[row, col]), 1)
                if values is not None and isfinite(float(values[row, col])) else None
            )
            lng_grid, lat_grid = rasterio.transform.xy(grid.transform, row, col, offset="center")
            results.append({
                "id": point["id"],
                "air_temperature_2m_c": round(temperature, 2),
                "feels_like_2m_c": optional_value(grid.feels_like_c),
                "relative_humidity_pct": optional_value(grid.relative_humidity_pct),
                "wind_speed_kmh": optional_value(grid.wind_speed_kmh),
                "rainfall_24h_mm": round(rain_24h, 2),
                "model_grid_center": {"lat": float(lat_grid), "lng": float(lng_grid)},
                "model_run": grid.model_run.isoformat(),
                "valid_start": grid.valid_start.isoformat(),
                "valid_end": grid.valid_end.isoformat(),
                "retrieved_at": grid.retrieved_at,
                "stale": stale,
            })
        except (KeyError, IndexError, TypeError, ValueError, OverflowError):
            continue
    return results, len(locations) - len(results)
