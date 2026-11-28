# Bengaluru coverage and model evaluation

## City boundary and search

The risk-data boundary is the five Greater Bengaluru Authority corporations. Its outline is a dissolved and 30 m simplified copy of the 2025 corporation polygons. Search indexes 369 notified wards by their English and Kannada names and zooms to the selected ward. Ward IDs use corporation and ward numbers together. Search coverage is limited to the ward index and its spelling aliases. The official map reference is [GBA city corporation maps](https://www.bbmp.gov.in/maps/). Machine-readable geometry is from OpenCity via the [bharatlas layer catalog](https://bharatlas.com/layers#city-wards), where the two layers are marked CC0.

The India-wide map, general place search, and driving services include southern suburbs through Anekal where providers have coverage. The municipal runoff and Landsat layers are clipped to the 2025 GBA polygon.

### Ward analysis and scenario comparison

Search for a ward to outline it and open its analysis. The ward mean weights the non-null value of each municipal runoff cell part by the area that intersects the ward in EPSG:32643. The “scored area above 20 mm” percentage uses only the intersection area with a runoff value as its denominator. Mapped permanent water and cells with missing values are excluded. This percentage describes grid values under a chosen rainfall input. Model runoff and observed inundation measure different quantities.

The temperature reading weights the historical Landsat display cells by their ward overlap. The included area is display-grid coverage and can differ from the area of valid Landsat pixels. The optional temperature offset applies uniformly to the historical value.

Use **Compare scenarios** to save the current inputs or a rainfall preset as a baseline in this browser. With a ward selected, the comparison uses that ward for both scenarios. The city view counts distinct 300 m cells above 20 mm. The CSV records the comparison scope, both inputs and outputs, and the source metadata. Baselines save the inputs and recalculate against the available model inputs on later visits. **Data sources** shows source availability and timestamps.

The checked-in ward evidence file can be regenerated with `python scripts/build_ward_evidence.py /path/to/wards.geojson` from the repository root with the backend environment active. Use the [OpenCity 2025 ward GeoJSON distributed by bharatlas](https://data.bharatlas.com/admin/wards-bengaluru-gba/wards_bengaluru_gba.a181f1d8.geojson), SHA-256 `53733db2674e9e1283dcc57172945b3b1963d2c25d84e57f571e49d3880af11e`, with the [catalog's CC0 designation](https://bharatlas.com/layers#city-wards). The script verifies its IDs against the atlas index and stores 15 m simplified display outlines. The intersection weights use the source ward polygons before display simplification.

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

XGBoost had lower pooled error but lost to both baselines on March 8. This is a date holdout against independent satellite acquisitions from the same Collection 2 product family; the scenes include both Landsat 8 and Landsat 9, with sensor and scene IDs recorded individually. Predictors come from the acquisition being mapped. The evaluation does not measure advance forecast skill, air temperature or agreement with in-situ thermometers. Training and test months focus on scenes with usable optical observations, so cloudy and monsoon conditions are underrepresented. The Bellandur single-scene spatial holdout is a different evaluation and its error is not directly comparable.

### Spatial-block evaluation

The same 16 training acquisitions are also evaluated with a deterministic spatial holdout across dates. Samples are grouped by their projected EPSG:32643 coordinates into fixed 900 m × 900 m blocks (30 Landsat grid pixels per side). Twenty percent of blocks are held out with seed 42; a one-block (900 m) buffer around held-out blocks is excluded from training. This keeps train and evaluation samples at least two block indices apart and groups repeated geographic areas consistently across acquisition dates. The final temporal model is still fit on all 480,000 configured training samples after the spatial evaluation is measured.

| Spatial held-out set | XGBoost RMSE | Linear RMSE | Training-mean RMSE | Pixels |
|---|---:|---:|---:|---:|
| Held-out 900 m blocks | 4.13 °C | 4.33 °C | 5.27 °C | 97,872 |

The spatial evaluation trained on 64,858 samples across 138 blocks and tested on 97,872 samples across 197 held-out blocks. These are sampled pixels from the same 16 acquisitions, not independent dates; the large-area buffer removes additional blocks from training. The reported score measures spatial transfer of same-acquisition LST patterns. It does not validate future air temperature, heat stress, or a heatwave warning. The evaluation JSON records exact scene, sensor, date/time, cloud cover, source/window transforms, CRS, resolution, feature schema, QA bits, preprocessing version, seed, parameters and metrics.

The configured XGBoost baseline uses 300 estimators, depth 6, histogram tree construction, four workers and random seed 42. Spatial and date evaluations compare it with a linear-regression baseline and a constant training-mean baseline. The final model is fit on the 480,000 training samples; the spatial evaluation model is fit only on its buffered training blocks.

The browser layer aggregates eligible April 1, 2026 modelled pixels into 300 m cells. Data available from the U.S. Geological Survey, accessed through [Microsoft Planetary Computer Landsat Collection 2](https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2).

```sh
cd backend
.venv/bin/python -m app.heat.city_study
.venv/bin/python -m app.heat.city_study --export-map
```

The study writes versioned scene manifests and sample caches, `evaluation.v2.json`, and `model.v2.json` under `backend/data/heat/city-study/`; the `v2` files preserve older local artifacts. Inputs and outputs are ignored and are not committed. The optional export writes the browser asset at `frontend/public/data/bengaluru-heat.json`.

## Citywide flood screening

The Bengaluru runoff toggle shows results from a 300 m grid across the Greater Bengaluru municipal outline. Copernicus GLO-30 elevation tiles N12 E077 and N13 E077 are averaged to a 60 m projected grid in EPSG:32643. ESA WorldCover 2021 v200 tile N12 E075 provides the modal land-cover class at each 60 m location. The project uses the resulting raster as a digital surface model, which can reflect buildings and vegetation.

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

Mapped road screening intersects visible OpenStreetMap/CARTO road geometry with the municipal grid at zoom 9 and above. Colored portions cross cells with at least 1 mm of screened runoff. Bridges and tunnels identified in the tiles are excluded from this overlay. Coverage follows the street geometry present at the current zoom. The values are cell-level scenario runoff, and the Bellandur pilot is the existing source of simulated depth.

## Display detail by zoom

The city flood and heat overlays share a display grid. Below zoom 11.5, the map uses 125 municipal-clipped hexagons with a 1.7 km radius. Between zoom 11.5 and 13 it uses 740 smaller hexagons with a 650 m radius. At zoom 13 and above, it shows the source 300 m cells. Each hexagon averages available source values by their intersection area. Missing data and water-only source cells are excluded from numeric averages. Model values and the Bellandur pilot overlays stay at their original resolution.

Regenerate the display mesh from the repository root with `backend/.venv/bin/python scripts/build_map_hexes.py`. The script computes intersections in EPSG:32643 and exports the clipped shapes and weights for the browser.

## Observed flood evaluation remains blocked

The Bellandur GNN has simulated targets. The optional real-map provider adds terrain and road geometry and uses inferred drainage and simulated targets. Evaluating predicted depths requires paired timestamps and observations. The event-specific backtest returns HTTP 501 when a suitable storm and surveyed-network run are unavailable.

The published Bengaluru study used observed gauge rainfall and stormwater water levels, including the storm on 20–21 October 2020. Its data availability statement says high-resolution KSNDMC observations are available by request. The next input required is a licensed export of timestamped rainfall and water-level or inundation observations with coordinates, units, quality flags, sensor type and reporting intervals, covering multiple storms. Use whole storms for the split and report event metrics separately from depth metrics. [IISc and KSNDMC study and data availability](https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2022.883842/full#h9).

## Current conditions for route comparisons

Open-Meteo Forecast API v1 provides a single Bengaluru reference estimate at 12.98° N, 77.59° E using automatic Best Match selection. The response carries the provider's returned grid-cell center and elevation, source units, UTC timezone/offset, retrieval time and each value's valid time. The selected model run/version and one fixed spatial resolution are not returned; the grid cell may be kilometres from the requested point. The route comparison rejects current estimates older than an hour, uses two completed hourly precipitation amounts and sums the following three hourly forecast amounts. The same city reference rainfall is applied to all candidate routes. These are forecast-model estimates, not station observations, road-level rainfall, flood predictions, or heatwave forecasts. The separate Landsat layer remains labelled by acquisition date. [Open-Meteo Forecast API documentation](https://open-meteo.com/en/docs).

The route screen measures road length inside 300 m cells with at least 1 mm of modeled runoff on depressions. Its recent screen uses the two completed hour amounts. Its upcoming screen adds the next three hourly estimates as a simple cumulative rainfall scenario. It excludes mapped permanent water and reports the route length inside the screened grid. The cutoff is a display criterion with no calibration to vehicle passability or congestion. Among routes with comparable coverage (at least 95% of each route), CityShield considers a difference of at least 100 m of projected exposure when recommending a route. Available nearby flood-report counts are compared first. The provider ETA orders the remaining candidates. This ranks returned road paths without excluding roads from the provider network.

The optional TomTom adapter sends traffic-enabled route requests and displays the difference between provider ETA and its comparable no-traffic estimate. It maps point-indexed traffic sections to no reported delay, slow traffic, heavy delay or closure, and unavailable detail. It separately checks present reports categorized as flooding within 35 m of the returned road geometry. A zero count represents zero matching reports in that feed. Observed flood-event validation and causal estimates of heat or flood effects on traffic still require paired road sensors, incident data and travel times. [TomTom Routing](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route) · [TomTom Incident Details](https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/traffic-incidents/incident-details).

When TomTom Routing leaves location-specific gaps, CityShield samples up to six points along the selected route using the Traffic Flow Segment API. It colors only aligned nearby edges where the returned geometry and direction match. Samples require provider confidence of at least 0.60. Speeds below 50% of free flow show heavy delay, speeds below 80% show slow traffic, and other matched samples show no delay. Unsampled edges without incident details remain grey if the provider reports an aggregate delay. [TomTom Traffic Flow Segment Data](https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/traffic-flow/flow-segment-data).

## Three-hour forecast watches and flood demo

The city watch requests five Open-Meteo forecast points across Greater Bengaluru. It assigns each terrain grid cell to the nearest returned forecast point and accumulates the recent two hours of precipitation plus each successive forecast hour. A flood watch appears when at least 10 distinct 300 m cells reach 5 mm of modeled runoff during a wet forecast window. The heat watch appears when modeled feels-like temperature reaches 40 °C at any sampled location. That is a CityShield advisory threshold. It is separate from IMD heatwave criteria and the Landsat surface-temperature evaluation. The report discloses the number of forecast points and links to official warnings. If the multipoint request fails, screening falls back to the central reference forecast when available. [Open-Meteo Forecast API](https://open-meteo.com/en/docs) · [IMD Met Centre Bengaluru](https://mausam.imd.gov.in/bengaluru/).

The **Flood demo** applies 200 mm of hypothetical rain over two hours. Existing candidate routes are intersected with the municipal runoff screen, with coverage shown per route. The demo ETA overlays hypothetical speed caps of 15 km/h in screened areas and 5 km/h above 20 mm of modeled runoff. It uses the provider ETA as its starting point and displays both values. These caps are presentation assumptions without evidence of road passability or observed delay. The car replay follows the selected path in roughly 35 seconds with GPS disabled for the replay.
