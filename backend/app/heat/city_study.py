"""Train and evaluate a citywide Landsat LST baseline on separate acquisition dates."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen

import numpy as np
import rasterio
from rasterio.features import geometry_mask, geometry_window
from rasterio.warp import transform, transform_geom
from sklearn.linear_model import LinearRegression
from xgboost import XGBRegressor

from app.heat.landsat import FEATURE_NAMES, prepare_feature_stack

CATALOG = "https://planetarycomputer.microsoft.com/api"
BANDS = {
    "blue": "SR_B2", "green": "SR_B3", "red": "SR_B4", "nir08": "SR_B5",
    "swir16": "SR_B6", "swir22": "SR_B7", "lwir11": "ST_B10",
    "emis": "ST_EMIS", "qa_pixel": "QA_PIXEL",
}
FEATURES = tuple(name for name in FEATURE_NAMES if name not in {"norm_row", "norm_col"})
BOUNDARY = Path("../frontend/public/data/bengaluru-boundary.geojson")
OUTPUT = Path("data/heat/city-study")
BBOX = "77.4600,12.8336,77.7844,13.1427"
TRAIN_DATES = (
    "20230201/20230228", "20230401/20230430", "20231101/20231130", "20240101/20240131",
    "20240201/20240229", "20240301/20240331", "20240401/20240430", "20240501/20240531",
    "20241101/20241130", "20241201/20241231", "20250101/20250131", "20250201/20250228",
    "20250301/20250331", "20250401/20250430", "20250501/20250531", "20251201/20251231",
)
TEST_DATES = ("20260101/20260131", "20260201/20260228", "20260301/20260331", "20260401/20260430")


def fetch_json(url: str) -> dict:
    with urlopen(url, timeout=30) as response:
        return json.load(response)


def pick_scene(period: str) -> dict:
    start, end = period.split("/")
    def fmt(date: str) -> str:
        return f"{date[:4]}-{date[4:6]}-{date[6:]}"
    query = urlencode({
        "collections": "landsat-c2-l2", "bbox": BBOX,
        "datetime": f"{fmt(start)}/{fmt(end)}", "limit": 100,
    })
    items = fetch_json(f"{CATALOG}/stac/v1/search?{query}")["features"]
    eligible = [
        item for item in items
        if item["id"].startswith(("LC08_L2SP_144051", "LC09_L2SP_144051"))
        and BANDS.keys() <= item["assets"].keys()
    ]
    if not eligible:
        raise RuntimeError(f"No compatible scene in {period}")
    return min(eligible, key=lambda item: (item["properties"]["eo:cloud_cover"], item["id"]))


def scene_samples(item: dict, geometry: dict, sample_limit: int | None) -> tuple[np.ndarray, np.ndarray, dict]:
    product = item["assets"]["lwir11"]["href"].rsplit("/", 1)[-1].removesuffix("_ST_B10.TIF")
    folder = OUTPUT / "scenes"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{product}.stac.json").write_text(json.dumps(item, indent=2))
    cache = folder / f"{product}.{sample_limit or 'all'}.npz"
    if cache.exists():
        with np.load(cache) as saved:
            return saved["features"], saved["target"], json.loads(str(saved["metadata"]))

    thermal_url = urlsplit(item["assets"]["lwir11"]["href"])
    account = thermal_url.hostname.split(".")[0]
    container = thermal_url.path.split("/")[1]
    token = fetch_json(f"{CATALOG}/sas/v1/token/{account}/{container}")["token"].lstrip("?")
    arrays = {}
    reference = None
    with rasterio.Env(GDAL_HTTP_TIMEOUT="30", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        for key, band in BANDS.items():
            url = item["assets"][key]["href"]
            if not url.startswith(f"https://{thermal_url.hostname}/{container}/"):
                raise ValueError("Unexpected Landsat asset host")
            with rasterio.open(f"{url}?{token}") as src:
                profile = (src.crs, src.transform, src.width, src.height)
                if reference is None:
                    reference = profile
                    projected = transform_geom("EPSG:4326", src.crs, geometry)
                    window = geometry_window(src, [projected])
                    affine = src.window_transform(window)
                if profile != reference:
                    raise ValueError("Landsat scene bands are misaligned")
                arrays[band] = src.read(1, window=window)
    qa = arrays.pop("QA_PIXEL")
    city_mask = geometry_mask([projected], out_shape=qa.shape, transform=affine, invert=True)
    date = item["properties"]["datetime"][:10]
    stack = prepare_feature_stack(
        arrays, qa, scene_id=product, acquisition_date=date,
        crs=reference[0].to_string(), transform=affine, aoi_mask=city_mask,
    )
    valid = np.flatnonzero(stack.valid_mask)
    if not valid.size:
        raise ValueError("No valid municipal pixels")
    if sample_limit and valid.size > sample_limit:
        sample = np.sort(np.random.default_rng(42).choice(valid, sample_limit, replace=False))
    else:
        sample = valid
    features = np.column_stack([stack.features[name].ravel()[sample] for name in FEATURES])
    target = stack.lst_c.ravel()[sample]
    metadata = {"scene_id": product, "date": date, "valid_pixels": int(valid.size), "city_pixels": int(city_mask.sum()), "used_pixels": len(sample)}
    rows, cols = np.unravel_index(sample, qa.shape)
    east, north = rasterio.transform.xy(affine, rows, cols)
    np.savez_compressed(
        cache, features=features, target=target, metadata=json.dumps(metadata),
        east=east, north=north, crs=stack.crs,
    )
    print(metadata, flush=True)
    return features, target, metadata


def metrics(target: np.ndarray, predictions: np.ndarray) -> dict:
    error = predictions - target
    return {
        "rmse_c": float(np.sqrt(np.mean(error**2))),
        "mae_c": float(np.mean(np.abs(error))),
        "bias_c": float(np.mean(error)),
    }


def main() -> None:
    assert set(FEATURES) <= set(FEATURE_NAMES)
    geometry = json.loads(BOUNDARY.read_text())["geometry"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        items = list(pool.map(pick_scene, (*TRAIN_DATES, *TEST_DATES)))
        jobs = [(item, 30_000 if index < len(TRAIN_DATES) else 100_000) for index, item in enumerate(items)]
        results = list(pool.map(lambda job: scene_samples(job[0], geometry, job[1]), jobs))
    train = results[:len(TRAIN_DATES)]
    test = results[len(TRAIN_DATES):]
    if max(row[2]["date"] for row in train) >= min(row[2]["date"] for row in test):
        raise ValueError("Training dates must precede every evaluation date")
    train_x = np.concatenate([row[0] for row in train])
    train_y = np.concatenate([row[1] for row in train])
    model = XGBRegressor(n_estimators=300, max_depth=6, n_jobs=4, random_state=42, tree_method="hist")
    model.fit(train_x, train_y)
    linear = LinearRegression().fit(train_x, train_y)
    evaluations = []
    for features, target, manifest in test:
        evaluations.append({
            **manifest,
            "xgboost": metrics(target, model.predict(features)),
            "linear_baseline": metrics(target, linear.predict(features)),
            "training_mean_baseline": metrics(target, np.full_like(target, train_y.mean())),
        })
    report = {
        "target": "Same-acquisition Landsat Level-2 surface temperature (°C), clear municipal pixels",
        "evaluation": "Chronological holdout by entire acquisition; independent Landsat dates, same sensor product family",
        "features": FEATURES, "random_seed": 42, "train_pixels": len(train_y),
        "model_parameters": model.get_params(), "training": [row[2] for row in train], "test": evaluations,
    }
    model.save_model(OUTPUT / "model.json")
    (OUTPUT / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(evaluations, indent=2))


def export_map() -> None:
    """Aggregate one held-out acquisition to 300 m cells for browser display."""
    report = json.loads((OUTPUT / "evaluation.json").read_text())
    selected = max(report["test"], key=lambda row: row["date"])
    product = selected["scene_id"]
    item = json.loads((OUTPUT / "scenes" / f"{product}.stac.json").read_text())
    geometry = json.loads(BOUNDARY.read_text())["geometry"]
    features, _, metadata = scene_samples(item, geometry, None)
    with np.load(OUTPUT / "scenes" / f"{product}.all.npz") as data:
        east, north, crs = data["east"], data["north"], str(data["crs"])
    if crs != "EPSG:32643":
        raise ValueError(f"Unexpected municipal scene CRS: {crs}")
    model = XGBRegressor(n_jobs=4)
    model.load_model(OUTPUT / "model.json")
    values = model.predict(features)
    cells, inverse = np.unique(np.column_stack([east, north]) // 300, return_inverse=True, axis=0)
    inverse = inverse.ravel()
    count = np.bincount(inverse)
    mean = np.bincount(inverse, weights=values) / count
    lngs, lats = transform(crs, "EPSG:4326", cells[:, 0] * 300 + 150, cells[:, 1] * 300 + 150)
    output = {
        "scene_id": product, "date": selected["date"], "resolution_m": 300,
        "valid_pixel_fraction": metadata["valid_pixels"] / metadata["city_pixels"],
        "rmse_c": selected["xgboost"]["rmse_c"],
        "cells": [
            [round(lng, 6), round(lat, 6), round(value, 2), f"{int(i)}:{int(j)}"]
            for lng, lat, value, (i, j) in zip(lngs, lats, mean, cells)
        ],
    }
    BOUNDARY.with_name("bengaluru-heat.json").write_text(json.dumps(output, separators=(",", ":")) + "\n")
    print(f"Exported {len(cells)} municipal heat cells from {selected['date']}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-map", action="store_true")
    if parser.parse_args().export_map:
        export_map()
    else:
        main()
