import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { api, type CityFloodResponse } from "./api/client";
import HeatProvenancePanel from "./components/HeatProvenancePanel";
import DrivingPlanner from "./components/DrivingPlanner";
import Icon, { type IconName } from "./components/Icon";
import { useDrivingPlanner, type Endpoint } from "./map/drivingPlanner";
import MapView, { type CityHeat } from "./components/MapView";
import MapMascot from "./components/mascot/MapMascot";
import { useAssistantOutlook } from "./map/assistantOutlook";
import PlaceSearch, { type MapPlace } from "./components/PlaceSearch";
import RouteComparisonPanel from "./components/RouteComparisonPanel";
import ScenarioSlider from "./components/ScenarioSlider";
import ThreeHourOutlook from "./components/ThreeHourOutlook";
import TwoDayWeatherReport from "./components/TwoDayWeatherReport";
import { useFloodStore } from "./store/useFloodStore";

const layers = [
  { key: "floodDepth", name: "Flood", icon: "flood", description: "Estimated surface runoff" },
  { key: "heat", name: "Heat", icon: "heat", description: "Landsat surface temperature" },
  { key: "combined", name: "Combined exposure", icon: "combined", description: "Bellandur flood + heat pilot" },
] as const;

type ToolPanel = "drive" | "outlook" | "weatherReport" | "rainfall" | "data";

const toolOptions: { id: ToolPanel; label: string; icon: IconName }[] = [
  { id: "drive", label: "Car routes", icon: "route" },
  { id: "outlook", label: "Next 3 hours", icon: "clock" },
  { id: "weatherReport", label: "Two-day weather report", icon: "calendar" },
  { id: "rainfall", label: "Rainfall scenario", icon: "rain" },
  { id: "data", label: "Data & models", icon: "database" },
];

function MapLayers({ cityHeat, cityFlood }: { cityHeat: CityHeat | null; cityFlood: CityFloodResponse | null }) {
  const visibility = useFloodStore((s) => s.layerVisibility);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const heat = useFloodStore((s) => s.heatData);
  const heatLoading = useFloodStore((s) => s.heatLoading);
  const heatError = useFloodStore((s) => s.heatError);
  const exposure = useFloodStore((s) => s.combinedExposure);
  const exposureError = useFloodStore((s) => s.combinedExposureError);
  const loading = useFloodStore((s) => s.loading);
  const simulationActive = useFloodStore((s) => s.simulationActive);
  const heatOffset = useFloodStore((s) => s.heatOffsetC);
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
  const status = { floodDepth: floodStatus, heat: heatStatus, combined: exposureStatus };

  return (
    <section className="layer-bar" aria-labelledby="layer-title">
      <h2 id="layer-title" className="sidebar-heading">Map layers</h2>
      <div className="layer-list">
        {layers.map(({ key, name, icon, description }) => (
          <div key={key} className={`layer-item layer-${icon}`}>
            <label className="layer-row">
              <input type="checkbox" checked={visibility[key]} onChange={() => toggleLayer(key)}
                disabled={!simulationActive && key !== "heat"}
                aria-labelledby={`label-${key}`}
                aria-describedby={visibility[key] ? `status-${key}` : undefined} />
              <span className="layer-symbol"><Icon name={icon} /></span>
              <span className="layer-label">
                <span id={`label-${key}`}>{name}</span>
                <small>{description}</small>
              </span>
              <span className="layer-switch" aria-hidden="true" />
            </label>
            <div className="layer-note" aria-live="polite">
              {visibility[key] && <p id={`status-${key}`}>{status[key]}{key === "heat" && heatOffset !== 0 &&
                ` · ${heatOffset > 0 ? "+" : ""}${heatOffset} °C scenario offset`}</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Dashboard() {
  const loadInitial = useFloodStore((s) => s.loadInitial);
  const error = useFloodStore((s) => s.error);
  const simulationActive = useFloodStore((s) => s.simulationActive);
  const showCityFlood = useFloodStore((s) => s.simulationActive && (s.layerVisibility.floodDepth || s.layerVisibility.cityRoads));
  const showPilot = useFloodStore((s) => s.layerVisibility.pilotFlood);
  const showRoads = useFloodStore((s) => s.layerVisibility.cityRoads);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const rainfallMm = useFloodStore((s) => s.currentRainfall.intensity * s.currentRainfall.duration / 60);
  const [place, setPlace] = useState<MapPlace | null>(null);
  const [cityHeat, setCityHeat] = useState<CityHeat | null>(null);
  const [cityFlood, setCityFlood] = useState<{ rainfallMm: number; value: CityFloodResponse } | null>(null);
  const [panel, setPanel] = useState<ToolPanel | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [picking, setPicking] = useState<Endpoint | null>(null);
  const drive = useDrivingPlanner();
  const weatherLocation = drive.navigationLocation ?? drive.points.destination ?? drive.points.source ??
    (place ? { lat: place.center[1], lng: place.center[0] } : { lat: 12.98, lng: 77.59 });
  const weatherLocationName = drive.navigationLocation ? "Current location"
    : drive.points.destination?.name ?? drive.points.source?.name ?? place?.name.split(",")[0] ?? "Bengaluru";
  const outlook = useAssistantOutlook();
  const scenarioRoute = drive.scenarioRoutes.find((route) => route.id === drive.selectedId);
  const carDemo = drive.navigationMode === "simulating" || drive.navigationMode === "arrived";
  const toolPanel = useRef<HTMLElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const mapHeading = useRef<HTMLHeadingElement>(null);

  const closePanel = useCallback(() => {
    setPanel(null);
    setToolsOpen(false);
    toolsTrigger.current?.focus();
  }, []);

  useEffect(() => {
    if (weatherOpen || (!toolsOpen && !picking)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (picking) {
        setPicking(null);
        setPanel("drive");
        setToolsOpen(true);
      } else {
        closePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toolsOpen, picking, weatherOpen, closePanel]);

  useEffect(() => {
    if (toolsOpen) {
      if (toolPanel.current) toolPanel.current.scrollTop = 0;
      panelHeading.current?.focus();
    }
    if (picking) mapHeading.current?.focus();
  }, [panel, picking, toolsOpen]);

  useEffect(() => {
    if (!useFloodStore.getState().loading) void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!showCityFlood) return;
    const controller = new AbortController();
    api.getCityFlood(rainfallMm, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCityFlood({ rainfallMm, value: result });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCityFlood({ rainfallMm, value: { status: "unavailable", message: "City flood screening could not load." } });
        }
      });
    return () => controller.abort();
  }, [rainfallMm, showCityFlood, reloadCount]);

  const displayedFlood = cityFlood?.rainfallMm === rainfallMm ? cityFlood.value : null;

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
      <a className="skip-link" href="#atlas">Skip to atlas</a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="CityShield home">
          <img className="wordmark-icon" src="/cityshield.svg" alt="" width="40" height="40" />
          <span>CityShield</span>
        </a>
        <PlaceSearch selected={place} onSelect={setPlace} placeholder="City, town or landmark in India" />
        <button ref={toolsTrigger} className="tools-trigger" type="button"
          aria-label={toolsOpen ? "Close map tools" : "Open map tools"} aria-expanded={toolsOpen} aria-controls="map-tools"
          onClick={() => {
            if (toolsOpen) closePanel();
            else {
              setPicking(null);
              setToolsOpen(true);
            }
          }}>
          <Icon name="more" />
        </button>
      </header>

      <main id="atlas" className="atlas" aria-label="India map" tabIndex={-1}>
        <section className="map-workspace" aria-labelledby="map-title">
          <MapView place={place} cityHeat={cityHeat}
            assistant={<MapMascot drive={drive} cityFlood={displayedFlood} outlook={outlook} weatherLocation={weatherLocation} />}
            cityFlood={displayedFlood?.status === "ready" ? displayedFlood : null}
            onReset={() => setPlace(null)}
            drivePoints={drive.points} drivingRoutes={drive.result?.routes} selectedDrivingId={drive.selectedId}
            scenarioRoute={scenarioRoute} trafficSegments={drive.liveTrafficSegments}
            navigation={{ mode: drive.navigationMode, location: drive.navigationLocation, routeMatch: drive.routeMatch }}
            onPickPoint={picking ? (point) => {
              drive.setPoint(picking, { ...point, name: `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` });
              setPicking(null);
              setPanel("drive");
              setToolsOpen(true);
            } : undefined} />

          <div className="map-overlay-left">
            <div className="map-context" data-picking={Boolean(picking)}>
              <Icon name={picking ? "extent" : "location"} />
              <div>
                <h1 id="map-title" ref={mapHeading} tabIndex={-1}>
                  {picking ? `Pick ${picking}` : place?.name ?? "India · Bengaluru risk layers"}
                </h1>
                {picking && <p role="status">Select a point on the map.</p>}
              </div>
              {picking && <button className="pick-button" type="button" onClick={() => {
                setPicking(null);
                setPanel("drive");
                setToolsOpen(true);
              }}>Cancel</button>}
            </div>
            {!picking && <MapLayers cityHeat={cityHeat} cityFlood={displayedFlood} />}
            {error && <div className="app-error" role="alert">
              <p><strong>Atlas data could not load.</strong> {error}</p>
              <button type="button" onClick={() => {
                void loadInitial();
                setReloadCount((count) => count + 1);
              }}>Reload data</button>
            </div>}
          </div>

          {carDemo && <div className="car-demo-control">
            <span role="status">{drive.navigationMode === "arrived" ? "Demo complete" : "Car simulation"}</span>
            <button type="button" className="pick-button" onClick={drive.stopNavigation}>{drive.navigationMode === "arrived" ? "Close demo" : "Stop car simulation"}</button>
          </div>}

          <div className="map-weather" hidden={Boolean(picking)}>
            <ThreeHourOutlook open={weatherOpen} outlook={outlook} location={weatherLocation} locationName={weatherLocationName} onOpen={() => setWeatherOpen(true)}
              onClose={() => setWeatherOpen(false)} />
          </div>
        </section>

        <aside id="map-tools" ref={toolPanel} hidden={!toolsOpen} className="tool-panel" data-panel={panel} aria-labelledby="map-tools-title">
          <div className="tool-title">
            {panel && <button type="button" className="close-button" aria-label="Back to map tools"
              onClick={() => setPanel(null)}><Icon name="back" /></button>}
            <h2 id="map-tools-title" ref={panelHeading} tabIndex={-1}>
              {toolOptions.find((option) => option.id === panel)?.label ?? "Map tools"}
            </h2>
            <button type="button" className="close-button" onClick={closePanel} aria-label="Close panel"><Icon name="close" /></button>
          </div>
          {!panel && <div className="tool-menu">
            {toolOptions.map(({ id, label, icon }) => (
              <button key={id} type="button" onClick={() => {
                if (id === "outlook") {
                  closePanel();
                  setWeatherOpen(true);
                } else {
                  setPanel(id);
                }
              }}>
                <span className="tool-menu-icon"><Icon name={icon} /></span><span>{label}</span><Icon name="chevron" />
              </button>
            ))}
            <p className="research-note"><Icon name="info" /><span>Research prototype. Follow official alerts for flood and heat warnings.</span></p>
          </div>}
          <div className="tool-content" hidden={panel !== "rainfall"}>
            <ScenarioSlider />
          </div>
          {panel === "weatherReport" && <div className="tool-content"><TwoDayWeatherReport outlook={outlook} location={weatherLocation} locationName={weatherLocationName} /></div>}
          {panel === "drive" && <div className="tool-content">
            <DrivingPlanner drive={drive} onSimulationStart={closePanel} onPick={(endpoint) => {
              setPicking(endpoint);
              setToolsOpen(false);
            }} />
          </div>}
          {panel === "data" && <div className="tool-content">
            <div className="detail-content">
              <h3>Bengaluru flood screening</h3>
              <p>Copernicus elevation and ESA WorldCover. Shading shows estimated local runoff generated on terrain depressions at the selected rainfall. Field validation is unavailable.</p>
              <label className="pilot-layer-option">
                <input type="checkbox" checked={showRoads} disabled={!simulationActive} onChange={() => toggleLayer("cityRoads")} />
                Show Bengaluru road runoff
              </label>
              <p>Road colors show where mapped roads cross screened 300 m cells. Road depth and passability require separate validation.</p>
              <label className="pilot-layer-option">
                <input type="checkbox" checked={showPilot} disabled={!simulationActive} onChange={() => toggleLayer("pilotFlood")} />
                Show Bellandur simulated depth and road segments
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
