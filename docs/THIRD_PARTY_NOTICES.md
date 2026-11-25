# Third-party notices

## Nimbus application foundation

- Source: [SagnickInTheShell/Nimbus](https://github.com/SagnickInTheShell/Nimbus)
- Audited revision: `0f8ec44c7e5eca164bede0a98e3f5a0137966b00`
- License and copyright notice: root [`LICENSE`](../LICENSE), MIT, Team Expecto Patronum, 2026.
- This repository imports the application source as its foundation. Preserve the notice with distributed copies.

## Bengaluru urban heat island reference

- Source: [NishanthAlampally/urban-heat-island-bengaluru](https://github.com/NishanthAlampally/urban-heat-island-bengaluru)
- Audited revision: `93ee4abb77eedeb00e5887d73f8cfba387506bb0`
- License and copyright notice: [`third_party/urban-heat-island-bengaluru/LICENSE`](../third_party/urban-heat-island-bengaluru/LICENSE), MIT, Nishanth Alampally, 2026.
- The heat preprocessing formulas and XGBoost/spatial-holdout workflow are adapted from its `notebooks/urban_heat_island.ipynb`. The reference notebook itself is not copied into this application. Attribution and license are retained here.

## External data specifications

- NOAA NCEI GHCNh hourly station data and the HAL archive are cited by dataset DOI and direct source URL in [`DATA_SOURCES.md`](DATA_SOURCES.md) and [`HEATWAVE_STATION_BASELINE.md`](HEATWAVE_STATION_BASELINE.md). The repository records a retrieval hash and attribution; it does not assert redistribution rights beyond provider terms.
- USGS Landsat Collection 2 scaling and QA documentation is linked in [`DATA_SOURCES.md`](DATA_SOURCES.md). Landsat input files remain user-supplied; no scene is bundled.
- OpenStreetMap data queried in optional real mode are licensed under ODbL and require attribution. The interactive CARTO basemap includes visible OpenStreetMap/CARTO attribution through MapLibre's attribution control; see [`DATA_SOURCES.md`](DATA_SOURCES.md) for links and usage notes.
- Optional AWS Terrain Tiles use a mixture of underlying sources; follow the per-source terms listed by the AWS Open Data Registry and Tilezen's attribution file. The default synthetic mode does not fetch terrain tiles.
- CARTO serves the configured basemap style under its basemap terms. It is a runtime third-party service and requires network access.
- See each dependency's own package metadata and license for third-party software. No other source repository's code has been imported for the heat workflow.
