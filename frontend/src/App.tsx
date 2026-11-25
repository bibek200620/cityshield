import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { api, type CityFloodResponse } from "./api/client";
import HeatProvenancePanel from "./components/HeatProvenancePanel";
import DrivingPlanner from "./components/DrivingPlanner";
import { useDrivingPlanner, type Endpoint } from "./map/drivingPlanner";
import MapView, { type CityHeat } from "./components/MapView";
import PlaceSearch, { type BengaluruPlace } from "./components/PlaceSearch";
import RouteComparisonPanel from "./components/RouteComparisonPanel";
import ScenarioSlider from "./components/ScenarioSlider";
import ThreeHourOutlook from "./components/ThreeHourOutlook";
import { useFloodStore } from "./store/useFloodStore";

const layers = [
  { key: "floodDepth", name: "Flood", color: "#2563b8" },
  { key: "heat", name: "Heat", color: "#c5692f" },
  { key: "combined", name: "Combined exposure", color: "#814eb4" },
] as const;

function MapLayers({ cityHeat, cityFlood }: { cityHeat: CityHeat | null; cityFlood: CityFloodResponse | null }) {
  const visibility = useFloodStore((s) => s.layerVisibility);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const heat = useFloodStore((s) => s.heatData);
  const heatLoading = useFloodStore((s) => s.heatLoading);
  const heatError = useFloodStore((s) => s.heatError);
  const exposure = useFloodStore((s) => s.combinedExposure);
  const exposureError = useFloodStore((s) => s.combinedExposureError);
  const loading = useFloodStore((s) => s.loading);
  const date = heat?.acquisition_date?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const heatStatus = cityHeat ? `Bengaluru · Landsat ${cityHeat.date}` :
    heatLoading ? "Loading Landsat data…" : heatError ? "Heat data could not load." :
    heat?.status === "ready" ? `Bellandur only · ${date}` : "Landsat heat data unavailable.";
  const exposureStatus = exposureError ? "Combined exposure could not load." :
    exposure?.status === "ready" ? exposure.message :
    exposure?.status === "unavailable" ? "Combined exposure needs both layers." :
    loading ? "Calculating exposure…" : "Run a rainfall simulation to see exposure.";
  const floodStatus = cityFlood?.status === "ready" ?
    `Bengaluru · ${Number(cityFlood.rainfall_mm.toFixed(1))} mm scenario rainfall` :
    cityFlood?.message ?? "Loading city flood screening…";

  return (
    <section className="layer-bar" aria-label="Map layers">
      <div className="layer-list">
        {layers.map(({ key, name, color }) => (
          <label key={key} className="layer-row">
            <input type="checkbox" checked={visibility[key]} onChange={() => toggleLayer(key)} />
            <span className="layer-dot" style={{ background: color }} />
            <span>{name}</span>
          </label>
        ))}
      </div>
      <div className="layer-notes" aria-live="polite">
        {visibility.floodDepth && <p>{floodStatus}</p>}
        {visibility.heat && <p>{heatStatus}</p>}
        {visibility.combined && <p>Bellandur pilot · {exposureStatus}</p>}
      </div>
    </section>
  );
}

function Dashboard() {
  const loadInitial = useFloodStore((s) => s.loadInitial);
  const error = useFloodStore((s) => s.error);
  const showCityFlood = useFloodStore((s) => s.layerVisibility.floodDepth);
  const showPilot = useFloodStore((s) => s.layerVisibility.pilotFlood);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const rainfallMm = useFloodStore((s) => s.currentRainfall.intensity * s.currentRainfall.duration / 60);
  const [place, setPlace] = useState<BengaluruPlace | null>(null);
  const [cityHeat, setCityHeat] = useState<CityHeat | null>(null);
  const [cityFlood, setCityFlood] = useState<CityFloodResponse | null>(null);
  const [panel, setPanel] = useState<"rainfall" | "data" | "drive" | "outlook" | null>(null);
  const [picking, setPicking] = useState<Endpoint | null>(null);
  const drive = useDrivingPlanner();
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const panelTrigger = useRef<HTMLButtonElement | null>(null);

  const closePanel = useCallback(() => {
    setPanel(null);
    panelTrigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!panel) return;
    panelHeading.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closePanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel, closePanel]);

  useEffect(() => {
    if (!useFloodStore.getState().loading) void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!showCityFlood) return;
    const controller = new AbortController();
    api.getCityFlood(rainfallMm, controller.signal)
      .then(setCityFlood)
      .catch(() => {
        if (!controller.signal.aborted) {
          setCityFlood({ status: "unavailable", message: "City flood screening could not load." });
        }
      });
    return () => controller.abort();
  }, [rainfallMm, showCityFlood]);

  const displayedFlood = cityFlood?.status === "ready" && cityFlood.rainfall_mm !== rainfallMm ? null : cityFlood;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/bengaluru-heat.json", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<CityHeat> : null)
      .then(setCityHeat)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <div className="cityshield">
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="CityShield home">
          <span className="wordmark-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M12 3l7 3v5c0 4.2-2.7 7.6-7 10-4.3-2.4-7-5.8-7-10V6l7-3Z" />
              <path d="M8 12c1.3-1.4 2.7-1.4 4 0s2.7 1.4 4 0" />
            </svg>
          </span>
          CityShield
        </a>
        <PlaceSearch selected={place} onSelect={setPlace} />
        <div className="header-actions">
          {(["drive", "outlook", "rainfall", "data"] as const).map((item) => (
            <button type="button" key={item} className="toolbar-button"
              aria-expanded={panel === item} aria-controls={panel === item ? "map-tools" : undefined}
              onClick={(event) => {
                setPicking(null);
                if (panel === item) {
                  closePanel();
                } else {
                  panelTrigger.current = event.currentTarget;
                  setPanel(item);
                }
              }}>
              {item === "drive" ? "Routes" : <>
                <span className="toolbar-full">{item === "outlook" ? "Next 3 hours" : item === "rainfall" ? "Rainfall scenario" : "Data & models"}</span>
                <span className="toolbar-short" aria-hidden="true">{item === "outlook" ? "3h" : item === "rainfall" ? "Rainfall" : "Data"}</span>
              </>}
            </button>
          ))}
        </div>
      </header>

      <main className="atlas" aria-label="Bengaluru map">
        <MapLayers cityHeat={cityHeat} cityFlood={displayedFlood} />
        <div className="map-workspace">
          <MapView place={place} cityHeat={cityHeat}
            cityFlood={displayedFlood?.status === "ready" ? displayedFlood : null}
            onReset={() => setPlace(null)}
            drivePoints={drive.points} drivingRoutes={drive.result?.routes} selectedDrivingId={drive.selectedId}
            navigation={{ mode: drive.navigationMode, location: drive.navigationLocation, routeMatch: drive.routeMatch }}
            onPickPoint={picking ? (point) => {
              drive.setPoint(picking, { ...point, name: `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` });
              setPicking(null);
              setPanel("drive");
            } : undefined} />

          <div className={picking ? "map-context route-prompt" : panel ? "map-context panel-open" : "map-context"}>
            <h1>{picking ? `Pick ${picking}` : place?.name ?? "Bengaluru"}</h1>
            {picking ? <p role="status">Select a point on the map. <button type="button" onClick={() => {
              setPicking(null);
              setPanel("drive");
            }}>Cancel</button></p>
              : <p>{place ? `${place.corporation} corporation` : "GBA risk data · map extends south to Anekal"}</p>}
          </div>

          {error && <div className="app-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => void loadInitial()}>Reload data</button>
          </div>}

          <aside id="map-tools" hidden={!panel} className="tool-panel" aria-labelledby="map-tools-title">
            <div className="tool-title">
              <h2 id="map-tools-title" ref={panelHeading} tabIndex={-1}>
                {panel === "drive" ? "Car routes" : panel === "outlook" ? "Next 3 hours" : panel === "rainfall" ? "Rainfall scenario" : "Data & models"}
              </h2>
              <button type="button" className="close-button" onClick={closePanel} aria-label="Close panel">×</button>
            </div>
            <div className="tool-content" hidden={panel !== "rainfall"}>
              <ScenarioSlider />
            </div>
            {panel === "outlook" && <div className="tool-content"><ThreeHourOutlook /></div>}
            {panel === "drive" && <div className="tool-content">
              <DrivingPlanner drive={drive} onPick={(endpoint) => {
                setPicking(endpoint);
                setPanel(null);
              }} />
            </div>}
            {panel === "data" && <div className="tool-content">
              <div className="detail-content">
                <h3>Bengaluru flood screening</h3>
                <p>Copernicus elevation and ESA WorldCover. Shading shows estimated local runoff generated on terrain depressions at the selected rainfall. Field validation is unavailable.</p>
                <label className="pilot-layer-option">
                  <input type="checkbox" checked={showPilot} onChange={() => toggleLayer("pilotFlood")} />
                  Show Bellandur pilot depth and roads
                </label>
              </div>
              {cityHeat && <div className="detail-content">
                <h3>Bengaluru heat model</h3>
                <p>USGS Landsat · {cityHeat.date} · {cityHeat.resolution_m} m display grid. Valid inputs cover {(cityHeat.valid_pixel_fraction * 100).toFixed(3)}% of municipal pixels on this date.</p>
                <p>Error on this held-out acquisition: {cityHeat.rmse_c.toFixed(2)} °C RMSE against Landsat surface temperature.</p>
                <p>Combined exposure uses the separate Bellandur pilot data.</p>
              </div>}
              <details className="tool-disclosure">
                <summary>Pilot model details</summary>
                <HeatProvenancePanel />
              </details>
              <details className="tool-disclosure">
                <summary>Simulated routes</summary>
                <RouteComparisonPanel />
              </details>
            </div>}
          </aside>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
    </Routes>
  );
}
