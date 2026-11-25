# Bengaluru Urban Flood & Heatwave Intelligence

A research app for Bengaluru. The map opens with Greater Bengaluru's 2025 municipal area and southern suburbs through Anekal in view. Current city flood and heat risk grids stop at the outlined 2025 Greater Bengaluru Authority boundary; areas south of it have basemap and routing coverage only. Bellandur depth and combined exposure use the separate pilot simulation. [Coverage and model evaluation](docs/BENGALURU_EVALUATION.md).

The application foundation comes from [Nimbus](https://github.com/SagnickInTheShell/Nimbus); heat feature preparation is adapted from [urban-heat-island-bengaluru](https://github.com/NishanthAlampally/urban-heat-island-bengaluru). See [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md) and the preserved MIT notices.

## What runs

- The map opens on the Bengaluru region, showing the 2025 Greater Bengaluru Authority boundary and southern suburbs through Anekal. Search 369 GBA wards in English or Kannada. The Flood layer displays a municipal 300 m grid derived from Copernicus elevation and ESA WorldCover, clipped to the GBA polygon. The rainfall form updates the city's local runoff screen. [City flood method and limits](docs/BENGALURU_EVALUATION.md#citywide-flood-screening).
- Flood presets and user-entered rainfall intensity/duration run the SCS-CN/graph-physics/FloodGNN workflow. The default is a deterministic **synthetic reference network** placed inside the Bellandur map extent for visual comparison. It is not observed Bellandur road, terrain, drainage, or facility data.
- GNN training labels are generated from the simplified physics baseline. Results are simulated and are not validated against observed flood events. MC Dropout uncertainty is included where returned by the existing model path.
- The city heat layer shows modelled land-surface temperature from the held-out April 1, 2026 Landsat acquisition. The separate Bellandur heat API and combined exposure require compatible local scene and model files.
- Combined exposure snaps independent flood node estimates and heat pixels onto a stable 30 m EPSG:32643 grid. “Both elevated” requires flood depth ≥0.15 m and a heat cell in the scene's relative top decile. It does not calculate compound probability.
- `GET /api/weather/nowcast` returns current and next-three-hour timestamped Bengaluru city-point weather-model estimates from Open-Meteo, with an unavailable state if data are stale or unreachable. They are not street-level observations, flood warnings, or heatwave forecasts. Historical flood-event validation remains unavailable because the project lacks verified, timestamped flood labels.

## Compare car routes

Open **Routes** on the map. Search for a place such as a college, hotel, building, or address and select a result, use **Use my current location** for the source, or use **Pick on map**. Place search queries OpenStreetMap Nominatim only after submit and is limited to the supported map bounds (77.44–77.80°E, 12.62–13.16°N); results depend on OSM coverage. The bounds include southern suburbs through Anekal, but do not imply flood/heat hazard coverage outside the GBA polygon. The map also has a **Find my location** control for browser GPS tracking. Both location options require browser permission.

The planner compares routes by estimated driving time and distance and shows an alternate when the provider supplies a distinct route. CityShield sends selected endpoint coordinates to the configured routing provider on comparison. Its default OpenStreetMap/Valhalla mode uses road-network travel-time estimates. Set `TOMTOM_API_KEY` in `backend/.env` and restart the backend to request TomTom traffic-aware ETAs and present flood reports near each route. Provider access and geographic coverage determine availability. [Valhalla documentation](https://valhalla.github.io/valhalla/api/route/api-reference/) · [TomTom Routing API](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route).

After comparing routes, choose one and press **Start navigation**. CityShield requests a fresh browser GPS fix, gets a route from that current position to the destination, and follows subsequent device location updates. The view shows GPS accuracy, speed when supplied, remaining distance and an ETA scaled from the route estimate; it can detect off-route fixes and recalculate. Location access requires browser permission and HTTPS (localhost is allowed). CityShield does not provide spoken or turn-by-turn instructions, and GPS availability/accuracy depends on the device and environment. It is not an official navigation or safety service.

Trip conditions show estimated air temperature, apparent temperature and rainfall. CityShield applies recent and forecast rainfall estimates to the city runoff screen and compares the distance each route spends in screened cells. This estimates modeled runoff exposure. Flood reports, where available, are a separate provider input. Heat and runoff have no validated conversion to traffic delay in CityShield, so they stay separate from the ETA.

VIALERT informed the route comparison workflow. Its congestion predictor uses heuristic rules and demo inputs. CityShield uses road-network travel times for the city comparison.

## Local setup

Requirements: Python 3.11, Node.js 20, npm, and (on macOS) Homebrew `libomp` for the XGBoost heat workflow.

```bash
# macOS, when XGBoost is used
brew install libomp

# Backend, from the repository root
cp .env.example backend/.env
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

On first startup, the default synthetic mode builds/trains its local FloodGNN checkpoint from generated physics-baseline scenarios. The output is simulation-derived. Keep the backend running, open a second terminal, and run:

```bash
cd frontend
cp .env.example .env
npm ci
npm run dev -- --host 127.0.0.1
```

Edit `frontend/.env` to configure `VITE_API_BASE_URL` or the map extent (`VITE_PILOT_BBOX`). Configure the heat AOI separately with backend `HEAT_AOI_BBOX`; configure the optional real flood ward with `REAL_WARD_BBOX`.

Open the map at <http://localhost:5173>. API documentation is at <http://127.0.0.1:8000/docs>; health status is <http://127.0.0.1:8000/api/health>. The basemap requires network access. Its CARTO and OpenStreetMap attribution is shown in the map.

The existing optional Compose setup is `docker compose up --build`; it uses PostGIS. Local commands use the default SQLite-compatible app configuration and need no database service.

## Run the heat workflow

Get a licensed single-scene Landsat 8/9 Collection 2 Level-2 scene from [USGS EarthExplorer](https://earthexplorer.usgs.gov/), then place the aligned `SR_B2`–`SR_B7`, `ST_B10`, `ST_EMIS`, and `QA_PIXEL` GeoTIFFs sharing one scene prefix in `backend/data/heat/landsat/`. Do not mix dates or sensors in one bundle. Set the scene directory/AOI if needed using `HEAT_SCENE_DIR` and `HEAT_AOI_BBOX` in `backend/.env`.

From `backend/`, with the venv active:

```bash
python -m app.heat.train
```

Training writes the XGBoost JSON model and metadata under `backend/data/heat/model/`. The metadata records feature order, source scene/date, CRS, pixel resolution, XGBoost version, spatial block holdout, seed, hyperparameters, and metrics. The reported metrics are a spatial holdout within this one acquisition, not independent temporal or city-wide validation. Restart or query the backend; `GET /api/heat` returns scene pixel-center LST predictions when the model metadata matches the input scene. See [`docs/HEAT_WORKFLOW.md`](docs/HEAT_WORKFLOW.md) for scaling, cloud/fill masking, exact files, outputs, and limitations.

## Verify changes

```bash
cd backend
python -m pytest -q

cd ../frontend
npm run lint
npm run build
```

Vite may report a bundle size advisory for the map libraries.

## Data, model and licensing notes

- Flood presets are scenario inputs, not observed rainfall. In synthetic mode, terrain, roads, drainage tags, land-use/curve numbers and facilities are generated. In `PILOT_MODE=real`, roads/facilities come from OpenStreetMap, terrain from AWS Terrain Tiles (Terrarium) unless a local DEM is supplied, and waterways are only inferred drainage proxies. Real-mode model outputs remain simulated and partly based on inferred/default inputs.
- No BBMP flood-prone spatial priors are loaded as event ground truth. Historical event evaluation remains unavailable.
- The municipal heat layer uses a historical Landsat acquisition. The separate Bellandur heat API needs local scene and model files. The three-hour panel and route planner use current modeled city-point air temperature and hourly estimates from Open-Meteo; they do not forecast land-surface temperature or a heatwave.
- Primary license and data attribution details are in [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) and [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md). The application preserves the Nimbus MIT notice; the UHI reference MIT notice is preserved under `third_party/`.

## Project docs

- [Heat preprocessing/training/inference](docs/HEAT_WORKFLOW.md)
- [Common grid and combined exposure](docs/GEO_ALIGNMENT.md)
- [Data sources and provenance](docs/DATA_SOURCES.md)
- [Third-party notices](docs/THIRD_PARTY_NOTICES.md)
- [Bengaluru coverage and model evaluation](docs/BENGALURU_EVALUATION.md)
- [Versioned model cards and experiment provenance](docs/MODEL_CARDS.md)

## License

MIT for the Nimbus-derived application foundation; see [`LICENSE`](LICENSE). The UHI reference MIT notice is preserved separately. Third-party data and map services retain their own licenses and terms.
