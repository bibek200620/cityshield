# CityShield India Weather & Routing

CityShield provides India-wide place search, road routing, and weather forecasts. The map opens over Bengaluru, where the research flood and heat layers are available. Flood screening is limited to the 2025 Greater Bengaluru Authority boundary, and the Bellandur depth and combined exposure layers use a separate pilot simulation. [Bengaluru coverage and model evaluation](docs/BENGALURU_EVALUATION.md).

The application foundation comes from [Nimbus](https://github.com/SagnickInTheShell/Nimbus); heat feature preparation is adapted from [urban-heat-island-bengaluru](https://github.com/NishanthAlampally/urban-heat-island-bengaluru). See [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md) and the preserved MIT notices.

## What runs

- Search Indian cities, towns, or Bengaluru wards. Place search, road routing and weather forecasts support locations across India. The Flood layer displays a municipal 300 m grid derived from Copernicus elevation and ESA WorldCover, clipped to the Greater Bengaluru Authority polygon. Flood and heat research outputs remain Bengaluru-specific. [City flood method and limits](docs/BENGALURU_EVALUATION.md#citywide-flood-screening).
- Flood presets and user-entered rainfall intensity/duration run the SCS-CN/graph-physics/FloodGNN workflow. The default is a deterministic **synthetic reference network** placed inside the Bellandur map extent for visual comparison. It is not observed Bellandur road, terrain, drainage, or facility data.
- GNN training labels are generated from the simplified physics baseline. Results are simulated and are not validated against observed flood events. MC Dropout uncertainty is included where returned by the existing model path.
- The city heat layer shows modelled land-surface temperature from the held-out April 1, 2026 Landsat acquisition. The separate Bellandur heat API and combined exposure require compatible local scene and model files.
- Combined exposure snaps independent flood node estimates and heat pixels onto a stable 30 m EPSG:32643 grid. “Both elevated” requires flood depth ≥0.15 m and a heat cell in the scene's relative top decile. It does not calculate compound probability.
- `GET /api/weather/nowcast` and `GET /api/weather/report` accept `latitude` and `longitude` for locations across India. They return current/three-hour and 48-hour Open-Meteo model estimates. The weather card follows the selected map location or navigation location. Forecasts are coarse provider-model outputs, not street-level observations, flood warnings, a CityShield-trained simulation or heatwave forecasts.

## Compare car routes

Open **Assistant** in the map footer for spoken alerts, a forecast report for 1–48 hours, or a trip report with traffic and rain exposure. The optional **Expressions** panel previews the original 3D model. The assistant watches the three-hour Bengaluru forecast for modeled flood risk. During navigation it compares your GPS progress with fresh traffic reports and modeled runoff ahead. It refreshes active route conditions every five minutes. Follow official warnings for street safety.

To enable Gemini phrasing, set `GEMINI_API_KEY` in `backend/.env` and restart the backend. The default is `GEMINI_MODEL=gemini-2.5-flash-lite`. Google limits access to established 2.5 accounts. If the default model returns HTTP 404, CityShield tries `gemini-3.5-flash-lite`. CX uses reviewed preset language when Gemini is unavailable. For alert phrasing, Gemini receives only alert categories. The browser supplies the voice. [Gemini 2.5 Flash-Lite availability](https://aistudio.google.com/docs/models/gemini-2.5-flash-lite).

To speak with CX, select **Talk to CX** and allow microphone access before driving. Say “Hello CX” for a greeting, or start with a request such as “CX agent, what’s the weather now?” Forecasts use the selected map or route location. Follow up with “And for the next six hours?” while CX is listening. After 45 seconds without a conversation turn, or when you say “stand by,” CX waits for a wake phrase again. Say “stop listening” or press the microphone status button to turn off the mic. Keep CityShield visible. Supported browsers may send microphone audio to their speech recognition service.

Say “CX agent, navigate to Lalbagh”. When CX reads matching places, say “yes” for a single match or say an option number. Allow location access to start GPS navigation. On an active route, ask for the next turn or how far is left, or say “stop navigation.” CityShield sends place queries and route endpoints to the existing map providers.

For open-ended travel, weather and CityShield questions, configure `GEMINI_API_KEY` in the backend environment. Conversation is enabled by default and can be turned off with `CX_CONVERSATION_ENABLED=false`. CityShield sends the transcribed question and up to four recent conversation messages to Gemini. The browser keeps this context in memory until CX returns to standby. Gemini classifies relevant weather and route requests, then CityShield fetches the forecast or route data. CX starts GPS navigation when you request a route from your current location.

For the demo, select **Rainfall scenario → Flood demo** and run it. CX announces the active scenario. Compared routes update with scenario exposure and a separate hypothetical demo ETA. **Start car simulation** replays the selected route without GPS and surfaces CX alerts along the way. The **Two-day weather report** highlights the three-hour flood and heat screens and plots 48 hours of rain estimates. Use **Choose voice** in CX to preview the English voices exposed by your device. [Forecast watch and demo methods](docs/BENGALURU_EVALUATION.md#three-hour-forecast-watches-and-flood-demo).

Open **Car routes** in the three-dot menu. Search for an Indian city, town, landmark, hotel, or address and select a suggestion, use **Use my current location** for the source, or use **Pick on map**. Search results depend on OpenStreetMap coverage and public geocoder capacity. India-wide routes use road-network estimates from Valhalla/OpenStreetMap or TomTom when configured. Bengaluru flood and heat screening does not extend to other regions. GPS requires browser permission.

Use **Scenarios**, **Routes**, **Weather**, or **Data sources** in the main navigation. Select **Next 3 hours** in the map overview to open the short forecast and its source. The two-day report shows 48 hourly Open-Meteo estimates for a Bengaluru grid cell, summarized into two 24-hour windows. **Refresh report** requests provider data. **Export CSV** downloads the 48 estimates with timestamps and source metadata.

Use **Storm replay** to inspect the published October 2020 drain readings and study peaks. An operator can [import authorized storms and export a matching surveyed drainage model run](docs/STORM_BUNDLE.md) to enable a paired comparison. [Published data sources](docs/FLOOD_EVENT_DATA.md).

The planner compares routes by estimated driving time and distance and shows an alternate when the provider supplies a distinct route. CityShield sends selected endpoint coordinates to the configured routing provider on comparison. Its default OpenStreetMap/Valhalla mode uses road-network travel-time estimates. Set `TOMTOM_API_KEY` in `backend/.env` and restart the backend to request TomTom traffic-aware ETAs and present flood reports near each route. Provider access and geographic coverage determine availability. [Valhalla documentation](https://valhalla.github.io/valhalla/api/route/api-reference/) · [TomTom Routing API](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route).

After comparing routes, choose one and press **Start navigation**, or confirm a place in voice mode. CityShield requests a fresh browser GPS fix, gets a route from that current position to the destination, and follows subsequent device location updates. The view shows GPS accuracy, speed when supplied, remaining distance and an ETA scaled from the route estimate. It can detect off-route fixes and recalculate. In voice mode, CX reads provider turn instructions when it has a reliable GPS position near the route. Location access requires browser permission and HTTPS (localhost is allowed). Follow road signs and local conditions.

Trip conditions show estimated air temperature, apparent temperature and rainfall. CityShield applies recent and forecast rainfall estimates to the city runoff screen and compares the distance each route spends in screened cells. CityShield recommends among the returned routes using nearby flood reports, materially different modeled runoff where coverage is comparable, and provider ETA. Fastest and shortest options remain available when returned. The route legend distinguishes no reported delay, slow traffic, and heavy delay or closures with TomTom data. Grey indicates unavailable traffic detail. Modeled runoff exposure and reported flooding do not change the provider ETA.

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

The [production frontend](https://cityshield-fawn.vercel.app) builds `frontend/` on Vercel. Set `VITE_API_BASE_URL` at build time to the HTTPS FastAPI service and include the frontend origin in the backend’s `CORS_ORIGINS`. The existing API is hosted on Render. Verify `/api/health` and `/api/backtest` from the production frontend origin after updating the backend.

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
