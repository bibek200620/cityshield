"""Validated Landsat 8/9 Collection 2 Level-2 feature preparation.

Feature formulas are adapted from the cited Bengaluru UHI reference notebook.
The input scene is user-supplied and remains the sole acquisition in a run.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import geometry_mask, geometry_window
from rasterio.warp import transform_geom
from shapely.geometry import box

FEATURE_NAMES = (
    "NDVI",
    "NDBI",
    "EMIS",
    "MNDWI",
    "norm_row",
    "norm_col",
    "ALBEDO",
    "BSI",
)
FEATURE_UNITS = {
    "NDVI": "unitless",
    "NDBI": "unitless",
    "EMIS": "unitless",
    "MNDWI": "unitless",
    "norm_row": "normalized pixel row [0,1]",
    "norm_col": "normalized pixel column [0,1]",
    "ALBEDO": "unitless",
    "BSI": "unitless",
}
REFLECTANCE_SCALE = 0.0000275
REFLECTANCE_OFFSET = -0.2
SURFACE_TEMPERATURE_SCALE = 0.00341802
SURFACE_TEMPERATURE_OFFSET_K = 149.0
EMISSIVITY_SCALE = 0.0001
QA_BAD_BITS = sum(1 << bit for bit in (0, 1, 2, 3, 4, 5))
LANDSAT_BANDS = ("SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7", "ST_B10", "ST_EMIS")


class LandsatDataError(ValueError):
    """Raised when the scene is incomplete or inconsistent."""


@dataclass(frozen=True)
class HeatSceneStack:
    scene_id: str
    acquisition_date: str
    crs: str
    transform: rasterio.Affine
    features: dict[str, np.ndarray]
    lst_c: np.ndarray
    valid_mask: np.ndarray

    @property
    def pixel_resolution_m(self) -> float:
        return float(max(abs(self.transform.a), abs(self.transform.e)))


def _safe_ratio(numerator: np.ndarray, denominator: np.ndarray) -> np.ndarray:
    out = np.full(denominator.shape, np.nan, dtype=np.float32)
    np.divide(numerator, denominator, out=out, where=np.abs(denominator) > 1e-8)
    return out


def prepare_feature_stack(
    raw_bands: dict[str, np.ndarray],
    qa_pixel: np.ndarray,
    *,
    scene_id: str,
    acquisition_date: str,
    crs: str,
    transform: rasterio.Affine,
    aoi_mask: np.ndarray | None = None,
) -> HeatSceneStack:
    """Scale one aligned scene and derive the ordered model features.

    QA_PIXEL fill, dilated cloud, cirrus, cloud, cloud shadow, and snow flags
    are excluded. Missing spectral denominators and fill values become NaN.
    """
    missing = sorted(set(LANDSAT_BANDS) - set(raw_bands))
    if missing:
        raise LandsatDataError(f"Scene is missing required bands: {', '.join(missing)}")

    arrays = {name: np.asarray(raw_bands[name], dtype=np.float32) for name in LANDSAT_BANDS}
    shapes = {arr.shape for arr in arrays.values()}
    qa = np.asarray(qa_pixel)
    if len(shapes) != 1 or len(next(iter(shapes))) != 2 or qa.shape != next(iter(shapes)):
        raise LandsatDataError("All Landsat bands and QA_PIXEL must be aligned 2D arrays")
    shape = qa.shape
    if aoi_mask is not None and np.asarray(aoi_mask).shape != shape:
        raise LandsatDataError("AOI mask shape must match the scene bands")

    raw = arrays
    reflectance = {
        name: raw[name] * REFLECTANCE_SCALE + REFLECTANCE_OFFSET
        for name in ("SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7")
    }
    b2, b3, b4 = reflectance["SR_B2"], reflectance["SR_B3"], reflectance["SR_B4"]
    b5, b6, b7 = reflectance["SR_B5"], reflectance["SR_B6"], reflectance["SR_B7"]

    with np.errstate(invalid="ignore", over="ignore"):
        lst_c = raw["ST_B10"] * SURFACE_TEMPERATURE_SCALE + SURFACE_TEMPERATURE_OFFSET_K - 273.15
        emis = raw["ST_EMIS"] * EMISSIVITY_SCALE
        ndvi = _safe_ratio(b5 - b4, b5 + b4)
        ndbi = _safe_ratio(b6 - b5, b6 + b5)
        mndwi = _safe_ratio(b3 - b6, b3 + b6)
        albedo = 0.356 * b2 + 0.130 * b4 + 0.373 * b5 + 0.085 * b6 + 0.072 * b7 - 0.0018
        bsi = _safe_ratio((b6 + b4) - (b5 + b2), (b6 + b4) + (b5 + b2))

    height, width = shape
    row, col = np.indices(shape, dtype=np.float32)
    features = {
        "NDVI": ndvi,
        "NDBI": ndbi,
        "EMIS": emis,
        "MNDWI": mndwi,
        "norm_row": row / max(height - 1, 1),
        "norm_col": col / max(width - 1, 1),
        "ALBEDO": albedo.astype(np.float32),
        "BSI": bsi,
    }

    valid = (qa.astype(np.uint16) & QA_BAD_BITS) == 0
    valid &= np.logical_and.reduce([np.isfinite(a) & (a > 0) for a in raw.values()])
    valid &= np.isfinite(lst_c)
    valid &= np.logical_and.reduce([np.isfinite(features[name]) for name in FEATURE_NAMES])
    if aoi_mask is not None:
        valid &= np.asarray(aoi_mask, dtype=bool)

    for name in FEATURE_NAMES:
        features[name] = np.where(valid, features[name], np.nan).astype(np.float32)
    lst_c = np.where(valid, lst_c, np.nan).astype(np.float32)

    return HeatSceneStack(
        scene_id=scene_id,
        acquisition_date=acquisition_date,
        crs=crs,
        transform=transform,
        features=features,
        lst_c=lst_c,
        valid_mask=valid,
    )


def load_landsat_scene(scene_dir: str | Path, bbox_wgs84: tuple[float, float, float, float]) -> HeatSceneStack:
    """Read a single Landsat 8/9 C2 L2 scene bundle clipped to the pilot bbox.

    Expected files share one Landsat product prefix and include SR_B2..SR_B7,
    ST_B10, ST_EMIS and QA_PIXEL GeoTIFFs. The product prefix carries the
    acquisition date; mixed scene IDs are rejected.
    """
    root = Path(scene_dir)
    candidates = sorted(root.glob("*_SR_B2.TIF"))
    if len(candidates) != 1:
        raise LandsatDataError(f"Expected one *_SR_B2.TIF scene in {root}; found {len(candidates)}")
    scene_id = candidates[0].name.removesuffix("_SR_B2.TIF")
    parts = scene_id.split("_")
    if not parts or parts[0] not in {"LC08", "LC09"} or len(parts) < 4:
        raise LandsatDataError("Only Landsat 8/9 Collection 2 scene IDs are supported")
    acquisition_date = parts[3]
    if len(acquisition_date) != 8 or not acquisition_date.isdigit():
        raise LandsatDataError("Scene ID does not contain a valid acquisition date")

    files = {name: root / f"{scene_id}_{name}.TIF" for name in (*LANDSAT_BANDS, "QA_PIXEL")}
    missing = [name for name, path in files.items() if not path.is_file()]
    if missing:
        raise LandsatDataError(f"Scene bundle is incomplete: missing {', '.join(missing)}")

    with rasterio.open(files["SR_B2"]) as reference:
        if reference.crs is None or not reference.crs.is_projected:
            raise LandsatDataError("Landsat scene must have a projected CRS")
        crs = reference.crs
        projected_aoi = transform_geom("EPSG:4326", crs, box(*bbox_wgs84).__geo_interface__)
        try:
            window = geometry_window(reference, [projected_aoi])
        except Exception as exc:
            raise LandsatDataError("Configured Bellandur AOI does not intersect the scene") from exc
        transform = reference.window_transform(window)
        height, width = int(window.height), int(window.width)
        inside_aoi = geometry_mask(
            [projected_aoi], out_shape=(height, width), transform=transform, invert=True
        )
        reference_profile = (reference.crs, reference.transform, reference.width, reference.height)

    arrays: dict[str, np.ndarray] = {}
    for name, path in files.items():
        with rasterio.open(path) as src:
            if (src.crs, src.transform, src.width, src.height) != reference_profile:
                raise LandsatDataError(f"Band {name} is not aligned with SR_B2")
            arrays[name] = src.read(1, window=window)

    return prepare_feature_stack(
        {name: arrays[name] for name in LANDSAT_BANDS},
        arrays["QA_PIXEL"],
        scene_id=scene_id,
        acquisition_date=acquisition_date,
        crs=crs.to_string(),
        transform=transform,
        aoi_mask=inside_aoi,
    )
