# Application architecture

## Flood scenario

The FastAPI service uses the existing Nimbus design: user-selected rainfall intensity/duration → SCS Curve Number runoff → graph-based simplified physics baseline → FloodGNN surrogate with MC Dropout → node depth estimates and road classes. The GNN targets are generated from the physics simulation, not observed flood events. The default `PILOT_MODE=synthetic` builds deterministic synthetic terrain, roads, drainage tags, curve numbers and placeholder facilities. The synthetic network is anchored inside the Bellandur bbox for map co-location; this does not make it observed local data.

When explicitly configured for `PILOT_MODE=real`, `RealWardProvider` uses an OSM road network, OSM facilities and an AWS Terrain Tiles DEM (or local DEM). Road proximity to OSM waterways is only an inferred drainage proxy, and the land-use/curve-number value remains an assumed flat CN=75. Real-mode results are still model simulations; the optional path was not used for the current default validation. See [`DATA_SOURCES.md`](DATA_SOURCES.md).

## Heat scene

`app.heat.landsat` loads one aligned Landsat 8/9 Collection 2 Level-2 scene, clips it to the configured Bellandur bbox, applies Collection 2 scale factors and QA_PIXEL masking, and derives the fixed feature order. `app.heat.model` trains/loads XGBoost with whole 30×30-pixel spatial blocks held out. With compatible local inputs, `GET /api/heat` serves modelled LST pixels and an XGBoost TreeSHAP summary. See [the verified local run](HEAT_WORKFLOW.md).

## Common grid

`GET /api/exposure/{scenario_id}` aligns independent flood node estimates and heat pixels to stable global 30 m cells in EPSG:32643. “Both elevated” means flood depth ≥0.15 m and independently top-decile predicted LST within the same cell. The endpoint does not estimate a compound probability and returns unavailable if a heat output is missing. See [`GEO_ALIGNMENT.md`](GEO_ALIGNMENT.md).

## Interface and external services

The React/TypeScript/Vite frontend uses MapLibre, deck.gl, and Zustand. The map draws India-wide NOAA GFS forecast hexes, NASA GIBS surface-temperature imagery, and separate Bengaluru and Bellandur research layers. Basemap and live forecast features require network access. The default pilot uses local synthetic inputs. The bundled ward index provides outlines and spatial weights for ward summaries and scenario comparisons.

The point forecast follows the selected Indian location. The standard forecast uses Open-Meteo. The point-forecast endpoint can use Meteoblue when configured. FastAPI uses Valhalla or TomTom to compare car routes and serves historical comparisons when an authorized event has a matching surveyed drainage run. The browser supplies GPS and CX speech. See the [README API reference](../README.md#api-reference), [data provenance](DATA_SOURCES.md), and [storm import workflow](STORM_BUNDLE.md).
