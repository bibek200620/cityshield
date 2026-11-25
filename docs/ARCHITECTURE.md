# Application architecture

## Flood scenario

The FastAPI service uses the existing Nimbus design: user-selected rainfall intensity/duration → SCS Curve Number runoff → graph-based simplified physics baseline → FloodGNN surrogate with MC Dropout → node depth estimates and road classes. The GNN targets are generated from the physics simulation, not observed flood events. The default `PILOT_MODE=synthetic` builds deterministic synthetic terrain, roads, drainage tags, curve numbers and placeholder facilities. The synthetic network is anchored inside the Bellandur bbox for map co-location; this does not make it observed local data.

When explicitly configured for `PILOT_MODE=real`, `RealWardProvider` uses an OSM road network, OSM facilities and an AWS Terrain Tiles DEM (or local DEM). Road proximity to OSM waterways is only an inferred drainage proxy, and the land-use/curve-number value remains an assumed flat CN=75. Real-mode results are still model simulations; the optional path was not used for the current default validation. See [`DATA_SOURCES.md`](DATA_SOURCES.md).

## Heat scene

`app.heat.landsat` loads one aligned Landsat 8/9 Collection 2 Level-2 scene, clips it to the configured Bellandur bbox, applies Collection 2 scale factors and QA_PIXEL masking, and derives the fixed feature order. `app.heat.model` trains/loads XGBoost with whole 30×30-pixel spatial blocks held out. With compatible local inputs, `GET /api/heat` serves modelled LST pixels and an XGBoost TreeSHAP summary. See [the verified local run](HEAT_WORKFLOW.md).

## Common grid

`GET /api/exposure/{scenario_id}` aligns independent flood node estimates and heat pixels to stable global 30 m cells in EPSG:32643. “Both elevated” means flood depth ≥0.15 m and independently top-decile predicted LST within the same cell. The endpoint does not estimate a compound probability and returns unavailable if a heat output is missing. See [`GEO_ALIGNMENT.md`](GEO_ALIGNMENT.md).

## Interface and external services

The React/TypeScript/Vite frontend uses MapLibre and Deck.gl. It has independent toggles for simulated flood outputs, remotely sensed/modelled LST, and the both-elevated overlay. Map attribution for CARTO/OpenStreetMap remains visible. The map basemap requires network access; the default flood simulation is local and deterministic. `/api/weather/nowcast` requests Open-Meteo Forecast API v1 for a single Bengaluru reference point and returns current plus three hourly forecast estimates with provenance. Provider timeouts, stale values, missing values and invalid responses are reported distinctly. The point estimate is not a neighbourhood observation or a public warning. See [`DATA_SOURCES.md`](DATA_SOURCES.md).
