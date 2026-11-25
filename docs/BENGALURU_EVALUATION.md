# Bengaluru coverage and model evaluation

## City boundary and search

The map covers the five Greater Bengaluru Authority corporations. Its outline is a dissolved and 30 m simplified copy of the 2025 corporation polygons. Search indexes 369 notified wards by their English and Kannada names and zooms to the selected ward. Ward IDs use corporation and ward numbers together. Search coverage is limited to the ward index and its spelling aliases. The official map reference is [GBA city corporation maps](https://www.bbmp.gov.in/maps/). Machine-readable geometry is from OpenCity via the [bharatlas layer catalog](https://bharatlas.com/layers#city-wards), where the two layers are marked CC0.

## City land-surface temperature

The city model uses six spectral features from USGS Landsat 8/9 Collection 2 Level-2 images over the municipal boundary. It selects the lowest scene-level cloud cover for each configured month on path 144, row 051, then excludes fill, clouds, shadows, snow and invalid values at pixel level. It samples 30,000 valid pixels per training scene and 100,000 per evaluation scene using seed 42. The 30 m input grid is the delivered Landsat product grid. The thermal instrument's native resolution is coarser. [USGS Level-2 surface temperature documentation](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature).

Training used 16 acquisitions from February 2023 through December 2025, with 480,000 sampled pixels. Testing used four later acquisitions and 400,000 sampled pixels. Each entire acquisition was excluded from training. Linear regression uses the same features and training rows. The constant baseline uses the mean training temperature.

| Held-out acquisition | XGBoost RMSE | Linear RMSE | Constant RMSE | XGBoost bias |
|---|---:|---:|---:|---:|
| 2026-01-19 | 4.41 °C | 4.67 °C | 5.47 °C | +3.67 °C |
| 2026-02-12 | 5.23 °C | 5.53 °C | 5.56 °C | +4.59 °C |
| 2026-03-08 | 2.63 °C | 2.20 °C | 2.53 °C | −0.82 °C |
| 2026-04-01 | 3.33 °C | 3.71 °C | 4.31 °C | −2.19 °C |
| **Pooled** | **4.03 °C** | **4.21 °C** | **4.63 °C** | |

XGBoost had lower pooled error but lost to both baselines on March 8. This is a date holdout against independent satellite acquisitions of the same product family. Predictors come from the acquisition being mapped. The evaluation does not measure advance forecast skill, air temperature or agreement with in-situ thermometers. Training and test months focus on scenes with usable optical observations, so cloudy and monsoon conditions are underrepresented. The Bellandur single-scene spatial holdout is a different evaluation and its error is not directly comparable.

The browser layer aggregates eligible April 1, 2026 modelled pixels into 300 m cells. Data available from the U.S. Geological Survey, accessed through [Microsoft Planetary Computer Landsat Collection 2](https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2).

```sh
cd backend
.venv/bin/python -m app.heat.city_study
.venv/bin/python -m app.heat.city_study --export-map
```

The study writes its scene manifests, input samples, evaluation JSON and XGBoost model under `backend/data/heat/city-study/`. The export writes the browser asset at `frontend/public/data/bengaluru-heat.json`.

## Citywide flood screening

The Flood toggle shows a 300 m grid across the Greater Bengaluru municipal outline. Copernicus GLO-30 elevation tiles N12 E077 and N13 E077 are averaged to a 60 m projected grid in EPSG:32643. ESA WorldCover 2021 v200 tile N12 E075 provides the modal land-cover class at each 60 m location. The project uses the resulting raster as a digital surface model, which can reflect buildings and vegetation.

An eight-neighbor Priority-Flood fill calculates the elevation difference to the spill level, allowing flow to leave the 4.2 km buffered raster boundary. A 60 m sample enters the depression screen if the computed difference is at least 1 m. SCS Curve Number runoff uses the submitted storm depth and assumed land-cover-specific curve numbers with initial abstraction coefficient 0.2. The displayed value is millimetres of estimated runoff generated on those depression samples, averaged over all land samples in the 300 m cell. Permanent water samples are excluded. Entirely water cells appear grey. The displayed bins are visualization intervals.

The 8,319 clipped polygon parts represent 8,269 grid cells and cover 99.989% of the simplified municipal polygon by projected area. The build processed 198,091 land samples and 2,136 permanent water samples inside the municipal mask. The layer uses uniform scenario rainfall and excludes upstream inflow, drainage structures and stormwater routing. This makes it a screening layer, with neither calibrated flood depths nor observed event scores. A light or zero-valued cell means the screen produced a low or zero estimate under its assumptions. Floods may still occur there.

```sh
cd backend
.venv/bin/python -m app.hydrology.build_city_flood
curl 'http://localhost:8000/api/flood/city?rainfall_mm=90'
```

The build writes `app/hydrology/bengaluru_flood_grid.json.gz`, a compact derived input for the API. Raw rasters stay at their source.

- Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. [Copernicus DEM terms](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM).
- © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. [ESA WorldCover 2021 v200](https://doi.org/10.5281/zenodo.7254221) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Depression-filling algorithm reference: [Barnes, Lehman and Mulla (2014)](https://doi.org/10.1016/j.cageo.2013.04.024).

## Display detail by zoom

The city flood and heat overlays share a display grid. Below zoom 11.5, the map uses 125 municipal-clipped hexagons with a 1.7 km radius. Between zoom 11.5 and 13 it uses 740 smaller hexagons with a 650 m radius. At zoom 13 and above, it shows the source 300 m cells. Each hexagon averages available source values by their intersection area. Missing data and water-only source cells are excluded from numeric averages. Model values and the Bellandur pilot overlays stay at their original resolution.

Regenerate the display mesh from the repository root with `backend/.venv/bin/python scripts/build_map_hexes.py`. The script computes intersections in EPSG:32643 and exports the clipped shapes and weights for the browser.

## Observed flood evaluation remains blocked

The Bellandur GNN has simulated targets. The optional real-map provider adds terrain and road geometry but still relies on inferred drainage and simulated targets. Historic rainfall totals, flood-prone area inventories and street reports without matched timestamps are insufficient to evaluate predicted depths. The existing backtest returns HTTP 501.

The published Bengaluru study used observed gauge rainfall and stormwater water levels, including the storm on 20–21 October 2020. Its data availability statement says high-resolution KSNDMC observations are available by request. The next input required is a licensed export of timestamped rainfall and water-level or inundation observations with coordinates, units, quality flags, sensor type and reporting intervals, covering multiple storms. Use whole storms for the split and report event metrics separately from depth metrics. [IISc and KSNDMC study and data availability](https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2022.883842/full#h9).

## Current conditions for route comparisons

Open-Meteo Forecast API v1 provides a single Bengaluru reference estimate at 12.98° N, 77.59° E using automatic Best Match selection. The response carries the provider's returned grid-cell center and elevation, source units, UTC timezone/offset, retrieval time and each value's valid time. The selected model run/version and one fixed spatial resolution are not returned; the grid cell may be kilometres from the requested point. The route comparison rejects current estimates older than an hour, uses two completed hourly precipitation amounts and sums the following three hourly forecast amounts. The same city reference rainfall is applied to all candidate routes. These are forecast-model estimates, not station observations, road-level rainfall, flood predictions, or heatwave forecasts. The separate Landsat layer remains labelled by acquisition date. [Open-Meteo Forecast API documentation](https://open-meteo.com/en/docs).

The route screen measures road length inside 300 m cells with at least 1 mm of modeled runoff on depressions. Its recent screen uses the two completed hour amounts. Its upcoming screen adds the next three hourly estimates as a simple cumulative rainfall scenario. It excludes mapped permanent water and reports the route length inside the screened grid. The cutoff is a display criterion with no calibration to vehicle passability or congestion. Lower exposure can be flagged among well-covered routes when the alternatives differ by at least 100 m.

The optional TomTom adapter sends traffic-enabled route requests and displays the difference between provider ETA and its comparable no-traffic estimate. It separately checks present reports categorized as flooding within 35 m of the returned road geometry. A zero count represents zero matching reports in that feed. Observed flood-event validation and causal estimates of heat or flood effects on traffic still require paired road sensors, incident data and travel times. [TomTom Routing](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route) · [TomTom Incident Details](https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/traffic-incidents/incident-details).
