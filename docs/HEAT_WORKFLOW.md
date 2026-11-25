# Landsat heat workflow

This page documents the Bellandur single-scene workflow and the separate Bengaluru multi-date study. Both estimate Landsat land-surface temperature (LST), not air temperature or a heatwave forecast.

## Required inputs

The repository does not include Landsat observations or a trained heat model. Obtain a licensed Landsat 8/9 Collection 2 Level-2 product from [USGS EarthExplorer](https://earthexplorer.usgs.gov/) for the pilot area. Place exactly one scene bundle in `backend/data/heat/landsat/`. Required GeoTIFFs must share the same product prefix and grid:

`SR_B2`, `SR_B3`, `SR_B4`, `SR_B5`, `SR_B6`, `SR_B7`, `ST_B10`, `ST_EMIS`, and `QA_PIXEL`.

Scene IDs must be Landsat 8/9 IDs and encode the acquisition date. Only pixels inside `HEAT_AOI_BBOX` are used. The default bbox is Bellandur, in west,south,east,north order (`77.655,12.915,77.680,12.940`). Change `HEAT_AOI_BBOX` in the backend environment to configure the pilot extent. All bands must have the same projected CRS, transform, width, and height.

The loader applies USGS Collection 2 scale/offset values: surface reflectance `DN × 0.0000275 − 0.2`, surface temperature `DN × 0.00341802 + 149 K`, and emissivity `DN × 0.0001`. It converts ST to Celsius. QA_PIXEL fill, dilated cloud, cirrus, cloud, cloud shadow, and snow bits are masked. Missing/fill values, invalid feature values, and pixels outside the AOI are excluded.

## Reproduce training

From the `backend/` directory, after installing the pinned backend requirements and providing the scene:

```bash
python -m app.heat.train
```

The command writes `data/heat/model/heat_lst_model.json` and its adjacent metadata JSON. Metadata records the scene ID/date, CRS, pixel resolution, feature order/units, preprocessing version, XGBoost version, hyperparameters, random seed, spatial split and held-out metrics. The holdout assigns whole 30×30-pixel blocks to train or test; it is a spatial holdout within this one acquisition, not temporal or city-wide validation. Metrics are produced only when training runs against the supplied scene.

The trained model artifact is bound to its exact scene ID, CRS, feature schema and XGBoost version. The API returns unavailable if scene/model files are missing or incompatible. It does not silently substitute a sample raster or pretrained model.

For local inference, start the backend as documented in the root README, then query `GET /api/heat`. The API returns pixel centers in WGS84 and reports the original CRS and resolution. The hotspot flag marks the within-scene top decile of predicted LST. The API and provenance panel also show mean absolute TreeSHAP contributions in °C from up to 256 valid pixels sampled evenly in raster order. The values describe the fitted model. XGBoost computes them directly, and the explanation is unavailable when the scene or model is incompatible.

## Verified Bellandur run

Use Landsat 8 product `LC08_L2SP_144051_20250414_20250424_02_T1`, acquired 2025-04-14 at 05:10:26 UTC, from EarthExplorer or the [Planetary Computer catalog item](https://planetarycomputer.microsoft.com/api/stac/v1/collections/landsat-c2-l2/items/LC08_L2SP_144051_20250414_02_T1). Data available from the U.S. Geological Survey. [USGS Level-2 product and usage terms](https://www.usgs.gov/landsat-missions/landsat-collection-2-level-2-science-products).

The local run used native, unresampled GeoTIFF windows at column 5209, row 4086, width 93 and height 94 in EPSG:32643. The full product works with the same training command because the loader clips it to this window. The local STAC item, USGS MTL JSON, band windows and trained artifacts are under the ignored `backend/data/heat/` directory.

XGBoost 3.1.2 trained on 5,273 pixels and evaluated on 2,694 pixels from separate spatial blocks. Held-out RMSE was 1.0048 °C and R² was 0.8466. Both metrics apply to this acquisition. The inference endpoint produced 7,967 LST estimates, including 797 relative hotspots at a threshold of 38.16 °C.

## Reproducibility and limitations

- Feature ordering is fixed: `NDVI`, `NDBI`, `EMIS`, `MNDWI`, `norm_row`, `norm_col`, `ALBEDO`, `BSI`.
- XGBoost parameters and random seed are in the saved metadata and `app/heat/model.py`.
- A single scene's ST_B10 values provide the target. Spatial holdout metrics therefore measure within-scene spatial generalisation only; they do not establish independent sensor, date, city-wide, air-temperature, or heatwave forecast accuracy.
- `app.heat.train` intentionally binds one model to one scene. The reusable city study in `app.heat.city_study` separately processes Landsat 8/9 Collection 2 Level-2 acquisitions with consistent feature order, QA, units, EPSG:32643 resolution and a shared 30 m pixel lattice. See [`BENGALURU_EVALUATION.md`](BENGALURU_EVALUATION.md) for its spatial and date holdouts.
- The multi-date model is not operational forecasting. It maps same-acquisition LST from that acquisition's spectral features, and the spatial/date holdouts measure only generalisation of this remote-sensing target.
- The dataset license and exact USGS product metadata must be retained by the person supplying scene files. Do not commit licensed scene files or credentials.
- The configured output is unavailable until real, compatible scene and model files have been provided and training has completed.

## Attribution

Feature formulas and the single-scene XGBoost/spatial-holdout approach are adapted from the notebook in [urban-heat-island-bengaluru](https://github.com/NishanthAlampally/urban-heat-island-bengaluru), MIT licensed. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the preserved [MIT license](../third_party/urban-heat-island-bengaluru/LICENSE).
