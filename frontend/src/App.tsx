import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { api, type CityFloodResponse, type LatLng } from "./api/client";
import FloodProvenancePanel from "./components/FloodProvenancePanel";
import HistoricalFloodTimeline from "./components/HistoricalFloodTimeline";
import DrivingPlanner from "./components/DrivingPlanner";
import CitizenSafetyPanel from "./components/CitizenSafetyPanel";
import ExplainabilityPanel from "./components/ExplainabilityPanel";
import Icon, { type IconName } from "./components/Icon";
import KpiStatsRow from "./components/KpiStatsRow";
import { useDrivingPlanner, type Endpoint } from "./map/drivingPlanner";
import MapView from "./components/MapView";
import MapMascot from "./components/mascot/MapMascot";
import PlaceSearch, { type MapPlace } from "./components/PlaceSearch";
import RouteComparisonPanel from "./components/RouteComparisonPanel";
import ScenarioComparison from "./components/ScenarioComparison";
import ScenarioSlider from "./components/ScenarioSlider";
import SourceHealthPanel from "./components/SourceHealthPanel";
import StormReplay from "./components/StormReplay";
import ThreeHourOutlook from "./components/ThreeHourOutlook";
import TwoDayWeatherReport from "./components/TwoDayWeatherReport";
import WardInspector, { type WardSummary } from "./components/WardInspector";
import { summarizeWardRunoff, type WardEvidenceIndex } from "./map/wardEvidence";
import UncertaintyPanel from "./components/UncertaintyPanel";
import { useFloodStore } from "./store/useFloodStore";
import { loadIndiaCities } from "./map/indiaCities";
import { isBengaluruWard } from "./map/places";

const layers = [
  { key: "floodDepth", name: "Flood", icon: "flood", description: "24-hour rainfall screening proxy" },
  { key: "heat", name: "Heat", icon: "heat", description: "2 m air-temperature forecast" },
  { key: "surfaceTemperature", name: "Surface temperature", icon: "heat", description: "Daily daytime satellite imagery" },
  { key: "combined", name: "Combined", icon: "heat", description: "Rain and air-temperature overlap screen" },
] as const;

type ToolPanel = "drive" | "outlook" | "weatherReport" | "rainfall" | "compare" | "replay" | "data";

const toolOptions: { id: ToolPanel; label: string; icon: IconName }[] = [
  { id: "drive", label: "Car routes", icon: "route" },
  { id: "outlook", label: "Next 3 hours", icon: "clock" },
  { id: "weatherReport", label: "Two-day weather report", icon: "calendar" },
  { id: "rainfall", label: "Rainfall scenario", icon: "rain" },
  { id: "compare", label: "Scenario comparison", icon: "combined" },
  { id: "replay", label: "Storm replay", icon: "clock" },
  { id: "data", label: "Data & models", icon: "database" },
];

const workspaces: { id: ToolPanel | null; label: string }[] = [
  { id: null, label: "Map" },
  { id: "rainfall", label: "Scenarios" },
  { id: "compare", label: "Compare scenarios" },
  { id: "replay", label: "Storm replay" },
  { id: "drive", label: "Routes" },
  { id: "weatherReport", label: "Weather" },
  { id: "data", label: "Data sources" },
];

const BENGALURU_DEFAULT: LatLng = { lat: 12.97194, lng: 77.59369 };

function isBengaluruArea(place: MapPlace | null) {
  return Boolean(place && /bengaluru|bangalore|bellandur/i.test(place.name)
    && place.center[0] >= 77.39 && place.center[0] <= 77.85
    && place.center[1] >= 12.57 && place.center[1] <= 13.21);
}

function MapLayers({ cityFlood }: { cityFlood: CityFloodResponse | null }) {
  const visibility = useFloodStore((s) => s.layerVisibility);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const heatOffset = useFloodStore((s) => s.heatOffsetC);
  const heatStatus = "India-wide 2 m air-temperature forecast, where data is available.";
  const surfaceTemperatureStatus = "Daily daytime satellite land-surface temperature imagery; separate from air temperature and may have cloud gaps.";
  const combinedStatus = "India-wide overlap of forecast rainfall and air temperature; screening thresholds are illustrative.";
  const floodStatus = cityFlood?.status === "ready" ?
    `Local 24-hour runoff screening · ${Number(cityFlood.rainfall_mm.toFixed(1))} mm scenario` :
    `Local runoff screening · ${cityFlood?.message ?? "Data unavailable."}`;
  const status = { floodDepth: floodStatus, heat: heatStatus, surfaceTemperature: surfaceTemperatureStatus, combined: combinedStatus };

  return (
    <section className="layer-bar" aria-labelledby="layer-title">
      <h2 id="layer-title" className="sidebar-heading">Map layers</h2>
      <div className="layer-list">
        {layers.map(({ key, name, icon, description }) => (
          <div key={key} className={`layer-item layer-${icon}`}>
            <label className="layer-row">
              <input type="checkbox" checked={visibility[key]} onChange={() => toggleLayer(key)}
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
  const stopSimulation = useFloodStore((s) => s.stopSimulation);
  const showPilot = useFloodStore((s) => s.layerVisibility.pilotFlood);
  const showRoads = useFloodStore((s) => s.layerVisibility.cityRoads);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const rainfallMm = useFloodStore((s) => s.currentRainfall.intensity * s.currentRainfall.duration / 60);
  const [place, setPlace] = useState<MapPlace | null>(null);
  const [wardIndex, setWardIndex] = useState<WardEvidenceIndex | null>(null);
  const [wardFailed, setWardFailed] = useState(false);
  const [wardRequest, setWardRequest] = useState(0);
  const currentPlace = useRef(place);
  currentPlace.current = place;
  const showCityFlood = useFloodStore((s) => s.simulationActive && isBengaluruArea(place)
    && (s.layerVisibility.floodDepth || s.layerVisibility.cityRoads || Boolean(place?.corporation)));
  const [currentArea, setCurrentArea] = useState<{ location: LatLng; name: string } | null>(null);
  const [cityFlood, setCityFlood] = useState<{ rainfallMm: number; value: CityFloodResponse } | null>(null);
  const [panel, setPanel] = useState<ToolPanel | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [picking, setPicking] = useState<Endpoint | null>(null);
  const drive = useDrivingPlanner();
  const weatherLocation = drive.navigationLocation ?? (place
    ? { lat: place.center[1], lng: place.center[0] } : currentArea?.location ?? BENGALURU_DEFAULT);
  const weatherLocationName = drive.navigationLocation ? "Current location"
    : place?.id === "device-location" ? currentArea?.name ?? "Current location"
      : place?.name.split(",")[0] ?? currentArea?.name ?? "Bengaluru";
  const selectPlace = useCallback((nextPlace: MapPlace | null) => {
    setPlace(nextPlace);
    if (nextPlace && toolsOpen) {
      setPanel(null);
      setToolsOpen(false);
    }
    if (useFloodStore.getState().simulationActive
      && (currentPlace.current?.id !== nextPlace?.id || !isBengaluruArea(nextPlace))) stopSimulation();
  }, [stopSimulation, toolsOpen]);
  const handleCurrentLocation = useCallback((location: LatLng) => {
    setCurrentArea({ location, name: "Your area" });
    selectPlace({ id: "device-location", name: "Current location", center: [location.lng, location.lat],
      bounds: [location.lng - 0.08, location.lat - 0.08, location.lng + 0.08, location.lat + 0.08] });
    void loadIndiaCities().then(({ places }) => {
      let nearest = places[0];
      let nearestDistance = Infinity;
      for (const city of places) {
        const latDelta = (city.lat - location.lat) * Math.PI / 180;
        const lngDelta = (city.lng - location.lng) * Math.PI / 180;
        const a = Math.sin(latDelta / 2) ** 2 + Math.cos(location.lat * Math.PI / 180)
          * Math.cos(city.lat * Math.PI / 180) * Math.sin(lngDelta / 2) ** 2;
        const distance = 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (distance < nearestDistance) { nearestDistance = distance; nearest = city; }
      }
      if (nearest && nearestDistance <= 60) {
        setCurrentArea({ location, name: nearest.name });
        setPlace((current) => current?.id === "device-location" ? { ...current, name: nearest.name } : current);
      }
    }).catch(() => {});
  }, [selectPlace]);
  const scenarioRoute = drive.scenarioRoutes.find((route) => route.id === drive.selectedId);
  const carDemo = drive.navigationMode === "simulating" || drive.navigationMode === "arrived";
  const toolPanel = useRef<HTMLElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const workspaceTrigger = useRef<HTMLButtonElement | null>(null);
  const mapHeading = useRef<HTMLHeadingElement>(null);

  const closePanel = useCallback(() => {
    setPanel(null);
    setToolsOpen(false);
    const opener = workspaceTrigger.current;
    workspaceTrigger.current = null;
    (opener ?? toolsTrigger.current)?.focus();
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
  const selectedWard = isBengaluruWard(place) ? place : null;
  const selectedWardId = selectedWard?.id;
  const selectedWardEvidence = selectedWard ? wardIndex?.[selectedWard.id] ?? null : null;
  const wardSummary: WardSummary | null = useMemo(() => {
    if (!selectedWardEvidence) return null;
    return {
      evidence: selectedWardEvidence,
      runoff: displayedFlood?.status === "ready" ? summarizeWardRunoff(selectedWardEvidence, displayedFlood) : null,
      heat: null,
    };
  }, [selectedWardEvidence, displayedFlood]);

  useEffect(() => {
    if (!selectedWardId) return;
    const controller = new AbortController();
    setWardFailed(false);
    fetch("/data/bengaluru-ward-evidence.json", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<WardEvidenceIndex> : Promise.reject(new Error("Ward evidence unavailable")))
      .then((index) => { if (!controller.signal.aborted) setWardIndex(index); })
      .catch(() => { if (!controller.signal.aborted) setWardFailed(true); });
    return () => controller.abort();
  }, [selectedWardId, wardRequest]);

  useEffect(() => {
    if (!selectedWardId || simulationActive) return;
    const presets = useFloodStore.getState().scenarios;
    const defaultScenario = presets.find((scenario) => scenario.scenario_id === "moderate") ?? presets[1] ?? presets[0];
    if (defaultScenario) {
      const state = useFloodStore.getState();
      void state.runScenario(defaultScenario.scenario_id, { air: state.heatOffsetC, surface: state.surfaceOffsetC });
    }
  }, [selectedWardId, simulationActive]);

  return (
    <div className="cityshield">
      <a className="skip-link" href="#atlas">Skip to atlas</a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="CityShield home">
          <span>CityShield</span>
        </a>
        <PlaceSearch selected={place} onSelect={selectPlace} placeholder="City, town or landmark in India" />
        <button ref={toolsTrigger} className="tools-trigger" type="button"
          aria-label={toolsOpen ? "Close map tools" : "Open map tools"} aria-expanded={toolsOpen} aria-controls="map-tools"
          onClick={() => {
            if (toolsOpen) closePanel();
            else {
              workspaceTrigger.current = null;
              setPicking(null);
              setToolsOpen(true);
            }
          }}>
          <Icon name="more" />
        </button>
      </header>

      <nav className="console-workspaces" aria-label="Console workspaces">
        {workspaces.map(({ id, label }) => <button key={label} type="button" aria-current={panel === id && toolsOpen ? "page" : undefined}
          onClick={(event) => {
            workspaceTrigger.current = event.currentTarget;
            if (id === null) { closePanel(); return; }
            setPanel(id);
            setPicking(null);
            setToolsOpen(true);
          }}>{label}</button>)}
      </nav>

      <main id="atlas" className="atlas" aria-label="India map" tabIndex={-1}>
        <section className="map-workspace" aria-labelledby="map-title">
          <MapView place={place} onCurrentLocation={handleCurrentLocation}
            assistant={<MapMascot drive={drive} cityFlood={displayedFlood} weatherLocation={weatherLocation} weatherLocationName={weatherLocationName} />}
            weatherWidget={<ThreeHourOutlook open={weatherOpen} location={weatherLocation} locationName={weatherLocationName} onOpen={() => setWeatherOpen(true)}
              onClose={() => setWeatherOpen(false)} />}
            cityFlood={displayedFlood?.status === "ready" ? displayedFlood : null}
            onReset={() => selectPlace(null)}
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
                  {picking ? `Pick ${picking}` : place?.name ?? "India-wide weather map"}
                </h1>
                {picking && <p role="status">Select a point on the map.</p>}
              </div>
              {picking && <button className="pick-button" type="button" onClick={() => {
                setPicking(null);
                setPanel("drive");
                setToolsOpen(true);
              }}>Cancel</button>}
            </div>
            {!picking && <MapLayers cityFlood={displayedFlood} />}
            {selectedWard && <WardInspector place={selectedWard} summary={wardSummary} flood={displayedFlood}
              heat={null} failed={wardFailed} onRetry={() => { setWardIndex(null); setWardRequest((count) => count + 1); }}
              onCompare={() => { setPanel("compare"); setToolsOpen(true); }} />}
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

        </section>

        <aside id="map-tools" ref={toolPanel} hidden={!toolsOpen} className="tool-panel" data-panel={panel}
          aria-label={panel === "compare" ? "Scenario comparison" : undefined} aria-labelledby="map-tools-title">
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
            <ScenarioSlider selectedPlace={place} onSelectPlace={selectPlace} />
          </div>
          {panel === "compare" && <div className="tool-content">
            <ScenarioComparison currentFlood={displayedFlood} place={selectedWard} ward={wardSummary} heat={null}
              onEdit={() => setPanel("rainfall")} retryActive={() => setReloadCount((count) => count + 1)}
              wardFailed={wardFailed} retryWard={() => { setWardIndex(null); setWardRequest((count) => count + 1); }} />
          </div>}
          {panel === "replay" && <div className="tool-content"><StormReplay /></div>}
          {panel === "weatherReport" && <div className="tool-content"><TwoDayWeatherReport location={weatherLocation} locationName={weatherLocationName} /></div>}
          {panel === "drive" && <div className="tool-content">
            <DrivingPlanner drive={drive} onSimulationStart={closePanel} onPick={(endpoint) => {
              setPicking(endpoint);
              setToolsOpen(false);
            }} />
          </div>}
          {panel === "data" && <div className="tool-content">
            <SourceHealthPanel location={weatherLocation} flood={displayedFlood} retry={() => {
              setReloadCount((count) => count + 1);
            }} />
            <HistoricalFloodTimeline />
            <div className="detail-content">
              <h3>Local flood screening</h3>
              <p>Elevation and land-cover inputs support a local terrain runoff screen for the selected rainfall. Field validation is unavailable.</p>
              <label className="pilot-layer-option">
                <input type="checkbox" checked={showRoads} disabled={!simulationActive} onChange={() => toggleLayer("cityRoads")} />
                Show local road runoff
              </label>
              <p>Road colors show where mapped roads cross screened 300 m cells. Road depth and passability require separate validation.</p>
              <label className="pilot-layer-option">
                <input type="checkbox" checked={showPilot} disabled={!simulationActive} onChange={() => toggleLayer("pilotFlood")} />
                Show simulated depth and road segments
              </label>
            </div>
            <details className="tool-disclosure">
              <summary>Flood model details</summary>
              <FloodProvenancePanel />
            </details>
            <details className="tool-disclosure">
              <summary>Simulated routes</summary>
              <RouteComparisonPanel />
            </details>
            {simulationActive && <>
              <p className="research-note"><Icon name="info" /><span>Select a simulated map node to update the explanation and uncertainty display.</span></p>
              <KpiStatsRow />
              <details className="tool-disclosure" open>
                <summary>Why is this area at risk?</summary>
                <ExplainabilityPanel />
              </details>
              <details className="tool-disclosure" open>
                <summary>Prediction spread</summary>
                <UncertaintyPanel />
              </details>
            </>}
            <div className="detail-content">
              <h3>Data coverage and limits</h3>
              <ul>
                <li>India-wide heat hexes use the same 2 m air-temperature forecast at every zoom. The separate Surface temperature map layer shows daily daytime satellite imagery, not a numeric per-hex value; clouds and acquisition timing can leave gaps.</li>
                <li>Rainfall is a forecast accumulation screen, not measured water level, road depth, or a flood alert.</li>
                <li>Local road and drainage outputs are research simulations. Their uncertainty is not calibrated against a complete observed flood-event set.</li>
                <li>Official warning feeds, colocated river or street gauges, air-quality feeds, UV observations, and verified cooling-centre inventories are not connected.</li>
              </ul>
            </div>
            <CitizenSafetyPanel place={place} />
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
