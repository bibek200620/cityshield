import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { api, type CityFloodResponse, type LatLng } from "./api/client";
import HeatProvenancePanel from "./components/HeatProvenancePanel";
import DrivingPlanner from "./components/DrivingPlanner";
import Icon, { type IconName } from "./components/Icon";
import { useDrivingPlanner, type Endpoint } from "./map/drivingPlanner";
import MapView, { type CityHeat } from "./components/MapView";
import MapMascot from "./components/mascot/MapMascot";
import PlaceSearch from "./components/PlaceSearch";
import { isBengaluruWard, supportsBengaluruSimulation, type MapPlace } from "./map/places";
import RouteComparisonPanel from "./components/RouteComparisonPanel";
import ScenarioComparison from "./components/ScenarioComparison";
import ScenarioSlider from "./components/ScenarioSlider";
import SourceHealthPanel from "./components/SourceHealthPanel";
import StormReplay from "./components/StormReplay";
import ThreeHourOutlook from "./components/ThreeHourOutlook";
import TwoDayWeatherReport from "./components/TwoDayWeatherReport";
import WardInspector, { type WardSummary } from "./components/WardInspector";
import { countHighRunoffCells, summarizeWardHeat, summarizeWardRunoff, type WardEvidenceIndex } from "./map/wardEvidence";
import { useWeatherNowcast } from "./map/weatherNowcast";
import { loadIndiaCities } from "./map/indiaCities";
import CitizenSafetyPanel from "./components/CitizenSafetyPanel";
import ExplainabilityPanel from "./components/ExplainabilityPanel";
import FloodProvenancePanel from "./components/FloodProvenancePanel";
import HistoricalFloodTimeline from "./components/HistoricalFloodTimeline";
import KpiStatsRow from "./components/KpiStatsRow";
import UncertaintyPanel from "./components/UncertaintyPanel";
import { useFloodStore } from "./store/useFloodStore";

const layers = [
  { key: "floodDepth", name: "Flood" },
  { key: "cityRunoff", name: "Bengaluru runoff" },
  { key: "heat", name: "Heat" },
  { key: "surfaceTemperature", name: "Surface temperature" },
  { key: "combined", name: "Combined" },
  { key: "cityHeat", name: "Bengaluru Landsat" },
  { key: "pilotExposure", name: "Bellandur combined exposure" },
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
  { id: "replay", label: "Storm replay" },
  { id: "drive", label: "Routes" },
  { id: "weatherReport", label: "Weather" },
  { id: "data", label: "Data sources" },
];

const BENGALURU_DEFAULT: LatLng = { lat: 12.97194, lng: 77.59369 };

const countFormat = new Intl.NumberFormat("en-IN");

function ScenarioOverview({ cityFlood, onEdit, onCompare }: {
  cityFlood: CityFloodResponse | null;
  onEdit: (button: HTMLButtonElement) => void;
  onCompare: (button: HTMLButtonElement) => void;
}) {
  const rainfall = useFloodStore((s) => s.currentRainfall);
  const active = useFloodStore((s) => s.simulationActive);
  const screenedCells = useMemo(() => cityFlood?.status === "ready" ? countHighRunoffCells(cityFlood) : null, [cityFlood]);

  return <section className="console-section scenario-overview" aria-labelledby="scenario-overview-title">
    <h2 id="scenario-overview-title" className="sidebar-heading">Rainfall scenario</h2>
    {active ? <dl className="overview-readings">
      <div>
        <dt>Rainfall input</dt>
        <dd>{Number((rainfall.intensity * rainfall.duration / 60).toFixed(1))} <small>mm</small></dd>
        <dd className="overview-detail">{rainfall.intensity} mm/h over {rainfall.duration} min</dd>
      </div>
      <div>
        <dt>Cells above 20 mm of modeled runoff</dt>
        <dd>{screenedCells !== null ? countFormat.format(screenedCells) : "—"}</dd>
      </div>
    </dl> : <p>Scenario stopped. Adjust rainfall to run a new one.</p>}
    <div className="overview-actions">
      <button type="button" className="primary-button" onClick={(event) => onEdit(event.currentTarget)}>Adjust rainfall</button>
      <button type="button" className="text-action" onClick={(event) => onCompare(event.currentTarget)}>
        Compare scenarios <Icon name="chevron" />
      </button>
    </div>
  </section>;
}

function PilotReadings() {
  const result = useFloodStore((s) => s.simulateResult);
  const loading = useFloodStore((s) => s.loading);
  const active = useFloodStore((s) => s.simulationActive);
  const atRisk = result?.road_segments.filter((road) => road.state === "at_risk").length;
  const flooded = result?.road_segments.filter((road) => road.state === "flooded").length;

  return <section className="console-section pilot-readings" aria-labelledby="pilot-title">
    <h2 id="pilot-title" className="sidebar-heading"><Icon name="extent" /> Bellandur pilot</h2>
    <p>{result ? (result.is_synthetic_ward ? "Synthetic reference network" : "Mapped network simulation") :
      loading ? "Loading simulation output…" : active ? "Model output unavailable" : "Simulation stopped"}</p>
    <dl>
      <div><dt>Road segments modeled</dt><dd>{result?.road_segments.length ?? "—"}</dd></div>
      <div><dt>At risk</dt><dd>{atRisk ?? "—"}</dd></div>
      <div><dt>Flooded</dt><dd className="reading-danger">{flooded ?? "—"}</dd></div>
      <div><dt>Facilities with access risk</dt><dd>{result?.at_risk_infra_ids.length ?? "—"}</dd></div>
    </dl>
  </section>;
}

function MapLayers({ cityHeat, cityFlood }: { cityHeat: CityHeat | null; cityFlood: CityFloodResponse | null }) {
  const visibility = useFloodStore((s) => s.layerVisibility);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const exposure = useFloodStore((s) => s.combinedExposure);
  const exposureError = useFloodStore((s) => s.combinedExposureError);
  const heatOffset = useFloodStore((s) => s.heatOffsetC);
  const surfaceOffset = useFloodStore((s) => s.surfaceOffsetC);
  const status = {
    floodDepth: "India forecast rainfall · 24-hour accumulation",
    cityRunoff: cityFlood?.status === "ready"
      ? `Bengaluru runoff scenario · ${Number(cityFlood.rainfall_mm.toFixed(1))} mm of input`
      : cityFlood?.message ?? "Run a Bengaluru rainfall scenario.",
    heat: "India forecast air temperature at 2 m",
    surfaceTemperature: "Daily daytime satellite imagery · cloud gaps possible",
    combined: "India forecast rainfall and air-temperature overlap",
    cityHeat: cityHeat ? `Bengaluru · historical Landsat ${cityHeat.date}` : "Municipal Landsat grid unavailable.",
    pilotExposure: exposureError ?? exposure?.message ?? "Run a Bengaluru rainfall simulation and supply compatible local Landsat inputs.",
  };

  const offsets = { heat: heatOffset, cityHeat: surfaceOffset };

  return (
    <section className="layer-bar" aria-labelledby="layer-title">
      <div className="layer-toolbar">
        <h2 id="layer-title">Map layers</h2>
        <div className="layer-list">
          {layers.map(({ key, name }) => (
            <label key={key} className="layer-row">
              <input type="checkbox" checked={visibility[key]} onChange={() => toggleLayer(key)}
                aria-labelledby={`label-${key}`}
                aria-describedby={visibility[key] ? `status-${key}` : undefined} />
              <span id={`label-${key}`}>{name}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="layer-status-list" aria-live="polite">
        {layers.map(({ key }) => {
          const offset = key === "heat" || key === "cityHeat" ? offsets[key] : 0;
          return visibility[key] && <p key={key} id={`status-${key}`}>
            {status[key]}{offset !== 0 && ` · ${offset > 0 ? "+" : ""}${offset} °C scenario offset`}
          </p>;
        })}
      </div>
    </section>
  );
}

function Dashboard() {
  const loadInitial = useFloodStore((s) => s.loadInitial);
  const loadHeat = useFloodStore((s) => s.loadHeat);
  const error = useFloodStore((s) => s.error);
  const simulationActive = useFloodStore((s) => s.simulationActive);
  const showPilot = useFloodStore((s) => s.layerVisibility.pilotFlood);
  const showRoads = useFloodStore((s) => s.layerVisibility.cityRoads);
  const toggleLayer = useFloodStore((s) => s.toggleLayer);
  const rainfallMm = useFloodStore((s) => s.currentRainfall.intensity * s.currentRainfall.duration / 60);
  const [place, setPlace] = useState<MapPlace | null>(null);
  const [currentArea, setCurrentArea] = useState<{ location: LatLng; name: string } | null>(null);
  const wardPlace = isBengaluruWard(place) ? place : null;
  const showCityFlood = simulationActive && supportsBengaluruSimulation(place);
  const [cityHeat, setCityHeat] = useState<CityHeat | null | undefined>(undefined);
  const [cityFlood, setCityFlood] = useState<{ rainfallMm: number; request: number; value: CityFloodResponse } | null>(null);
  const [wardIndex, setWardIndex] = useState<WardEvidenceIndex | null>(null);
  const [wardFailed, setWardFailed] = useState(false);
  const [wardRequest, setWardRequest] = useState(0);
  const [panel, setPanel] = useState<ToolPanel | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const replayOpen = toolsOpen && panel === "replay";
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [picking, setPicking] = useState<Endpoint | null>(null);
  const drive = useDrivingPlanner();
  const liveLocation = drive.navigationMode === "active" ? drive.navigationLocation : null;
  const deviceLocation = liveLocation ?? (place?.id === "device-location"
    ? { lat: place.center[1], lng: place.center[0] } : null);
  const weatherLocation = deviceLocation
    ? { lat: Number(deviceLocation.lat.toFixed(2)), lng: Number(deviceLocation.lng.toFixed(2)) }
    : place ? { lat: place.center[1], lng: place.center[0] } : BENGALURU_DEFAULT;
  const weatherLocationName = liveLocation ? "Current location"
    : place?.id === "device-location" ? currentArea?.name ?? "Current location"
      : place?.name.split(",")[0] ?? "Bengaluru";
  const selectPlace = useCallback((nextPlace: MapPlace | null) => {
    setPlace(nextPlace);
    const store = useFloodStore.getState();
    if (!supportsBengaluruSimulation(nextPlace) && (store.simulationActive || store.loading && store.scenarios.length > 0)) {
      store.stopSimulation();
    }
  }, []);
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
  const nowcast = useWeatherNowcast(weatherLocation);
  const scenarioRoute = drive.scenarioRoutes.find((route) => route.id === drive.selectedId);
  const carDemo = drive.navigationMode === "simulating" || drive.navigationMode === "arrived";
  const toolPanel = useRef<HTMLElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const panelOpener = useRef<HTMLButtonElement | null>(null);
  const shouldRestoreFocus = useRef(false);
  const mapHeading = useRef<HTMLHeadingElement>(null);

  const closePanel = useCallback(() => {
    shouldRestoreFocus.current = true;
    setPanel(null);
    setToolsOpen(false);
  }, []);

  function openPanel(next: ToolPanel, trigger: HTMLButtonElement) {
    panelOpener.current = trigger;
    setPicking(null);
    setPanel(next);
    setToolsOpen(true);
  }

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
    if (!toolsOpen && !picking && shouldRestoreFocus.current) {
      shouldRestoreFocus.current = false;
      (panelOpener.current ?? toolsTrigger.current)?.focus();
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
        if (!controller.signal.aborted) setCityFlood({ rainfallMm, request: reloadCount, value: result });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCityFlood({ rainfallMm, request: reloadCount, value: { status: "unavailable", message: "City flood screening could not load." } });
        }
      });
    return () => controller.abort();
  }, [rainfallMm, showCityFlood, reloadCount]);

  const displayedFlood = showCityFlood && cityFlood?.rainfallMm === rainfallMm && cityFlood.request === reloadCount ? cityFlood.value : null;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/bengaluru-heat.json", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<CityHeat> : null)
      .then((result) => { if (!controller.signal.aborted) setCityHeat(result); })
      .catch(() => { if (!controller.signal.aborted) setCityHeat(null); });
    return () => controller.abort();
  }, [reloadCount]);

  const hasWard = wardPlace !== null;
  useEffect(() => {
    if (!hasWard || wardIndex) return;
    const controller = new AbortController();
    void fetch("/data/bengaluru-ward-evidence.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Ward evidence is unavailable.");
        return response.json() as Promise<WardEvidenceIndex>;
      })
      .then((value) => {
        if (!controller.signal.aborted) {
          setWardIndex(value);
          setWardFailed(false);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setWardFailed(true); });
    return () => controller.abort();
  }, [hasWard, wardIndex, wardRequest]);

  const ward = wardPlace ? wardIndex?.[wardPlace.id] : null;
  const wardSummary = useMemo<WardSummary | null>(() => ward ? {
    evidence: ward,
    runoff: displayedFlood?.status === "ready" ? summarizeWardRunoff(ward, displayedFlood) : null,
    heat: cityHeat ? summarizeWardHeat(ward, cityHeat) : null,
  } : null, [cityHeat, displayedFlood, ward]);
  const wardUnavailable = wardFailed || Boolean(wardPlace && wardIndex && !ward);

  function retryWard() {
    setWardFailed(false);
    setWardIndex(null);
    setWardRequest((count) => count + 1);
  }

  function retryScreen() {
    setReloadCount((count) => count + 1);
  }

  return (
    <div className="cityshield">
      <a className="skip-link" href="#atlas">{replayOpen ? "Skip to replay" : "Skip to map"}</a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="CityShield home">
          <span>CityShield</span>
        </a>
        <PlaceSearch selected={place} onSelect={(selected) => {
          selectPlace(selected);
          if (replayOpen) {
            setPanel(null);
            setToolsOpen(false);
          }
        }} />
        <div className="header-status">
          <button ref={toolsTrigger} className="tools-trigger" type="button"
            aria-label={toolsOpen ? "Close map tools" : "Open map tools"} aria-expanded={toolsOpen} aria-controls="map-tools"
            onClick={(event) => {
              if (toolsOpen) closePanel();
              else {
                panelOpener.current = event.currentTarget;
                setPicking(null);
                setToolsOpen(true);
              }
            }}>
            <Icon name="more" />
          </button>
        </div>
      </header>

      <div className="console-nav">
        <nav aria-label="Console workspaces">
          {workspaces.map(({ id, label }) => (
            <button key={label} type="button" aria-pressed={id === (toolsOpen ? panel : null)}
              aria-controls={id ? "map-tools" : "map-title"}
              onClick={(event) => {
                if (id) openPanel(id, event.currentTarget);
                else {
                  panelOpener.current = event.currentTarget;
                  closePanel();
                  setPicking(null);
                  event.currentTarget.focus();
                }
              }}>{label}</button>
          ))}
        </nav>
      </div>

      <main id="atlas" className="atlas" data-panel={toolsOpen ? panel : undefined}
        aria-label={replayOpen ? "Historical storm" : "India risk map"} tabIndex={-1}>
        <section className="map-workspace" aria-labelledby="map-title" hidden={replayOpen}>
          <div className="map-context" data-picking={Boolean(picking)}>
            <div>
              <h1 id="map-title" ref={mapHeading} tabIndex={-1}>
                {picking ? `Pick ${picking}` : place?.name ?? "India-wide weather map"}
              </h1>
              {picking && <p role="status">Select a point on the map.</p>}
            </div>
            {picking ? <button className="pick-button" type="button" onClick={() => {
              setPicking(null);
              setPanel("drive");
              setToolsOpen(true);
            }}>Cancel</button> : <>
              <span className="map-region">{wardPlace ? `${wardPlace.corporation} corporation` : "India"}</span>
              {wardPlace && <a className="mobile-ward-link" href="#ward-inspector-title">Ward analysis <Icon name="chevron" /></a>}
            </>}
          </div>
          <MapLayers cityHeat={cityHeat ?? null} cityFlood={displayedFlood} />
          {error && <div className="app-error" role="alert">
            <p><strong>Some map data could not load.</strong> {error}</p>
            <button type="button" onClick={() => {
              void loadInitial();
              retryScreen();
            }}>Reload data</button>
          </div>}
          <div className="map-stage">
            <MapView place={place} wardOutline={ward?.geometry} cityHeat={cityHeat ?? null} onCurrentLocation={handleCurrentLocation}
              assistant={<MapMascot drive={drive} cityFlood={displayedFlood} weatherLocation={weatherLocation} weatherLocationName={weatherLocationName} />}
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

            {carDemo && <div className="car-demo-control">
              <span role="status">{drive.navigationMode === "arrived" ? "Demo complete" : "Car simulation"}</span>
              <button type="button" className="pick-button" onClick={drive.stopNavigation}>{drive.navigationMode === "arrived" ? "Close demo" : "Stop car simulation"}</button>
            </div>}
          </div>
        </section>

        <aside className="intel-rail" aria-label="Map overview" hidden={toolsOpen}>
          {wardPlace && <WardInspector place={wardPlace} summary={wardSummary} flood={displayedFlood}
            heat={cityHeat ?? null} failed={wardUnavailable} onRetry={retryWard} onCompare={(trigger) => openPanel("compare", trigger)} />}
          <ScenarioOverview cityFlood={displayedFlood}
            onEdit={(trigger) => openPanel("rainfall", trigger)}
            onCompare={(trigger) => openPanel("compare", trigger)} />
          <section className="console-section" aria-labelledby="forecast-rail-title">
            <h2 id="forecast-rail-title" className="sidebar-heading">Weather</h2>
            <ThreeHourOutlook open={weatherOpen} location={weatherLocation} locationName={weatherLocationName} nowcast={nowcast} onOpen={() => setWeatherOpen(true)}
              onClose={() => setWeatherOpen(false)} />
            <button type="button" className="text-action" onClick={(event) => openPanel("weatherReport", event.currentTarget)}>
              Open 48-hour forecast <Icon name="chevron" />
            </button>
          </section>
          <p className="rail-footnote">CityShield provides research estimates. Follow official flood and heat warnings.</p>
        </aside>

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
            <ScenarioSlider selectedPlace={place} onSelectPlace={selectPlace} />
            <button type="button" className="text-action scenario-compare-link" onClick={() => setPanel("compare")}>
              Open scenario comparison <Icon name="chevron" />
            </button>
          </div>
          {panel === "compare" && <div className="tool-content">
            <ScenarioComparison currentFlood={displayedFlood} place={wardPlace} ward={wardSummary} heat={cityHeat ?? null}
              wardFailed={wardUnavailable} retryWard={retryWard} onEdit={() => setPanel("rainfall")} retryActive={retryScreen} />
          </div>}
          {panel === "replay" && <div className="tool-content"><StormReplay /></div>}
          {panel === "weatherReport" && <div className="tool-content"><TwoDayWeatherReport key={`${weatherLocation.lat},${weatherLocation.lng}`} location={weatherLocation} locationName={weatherLocationName} /></div>}
          {panel === "drive" && <div className="tool-content">
            <DrivingPlanner drive={drive} onSimulationStart={closePanel} onPick={(endpoint) => {
              setPicking(endpoint);
              setToolsOpen(false);
            }} />
          </div>}
          {panel === "data" && <div className="tool-content">
            <SourceHealthPanel nowcast={nowcast} locationName={weatherLocationName} flood={displayedFlood} heat={cityHeat ?? null} heatFailed={cityHeat === null}
              retry={() => {
                nowcast.refresh();
                void loadHeat();
                setCityHeat(undefined);
                retryScreen();
              }} />
            <div className="detail-content">
              <h3>Bengaluru flood screening</h3>
              <p>Copernicus elevation and ESA WorldCover. Shading shows estimated local runoff in terrain depressions under the selected rainfall. The grid ends at the 2025 Greater Bengaluru boundary. Field validation is unavailable.</p>
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
              <p>The Bellandur combined exposure layer uses the separate pilot dataset.</p>
            </div>}
            <details className="tool-disclosure">
              <summary>Pilot model details</summary>
              <PilotReadings />
              <HeatProvenancePanel />
              <FloodProvenancePanel />
            </details>
            <details className="tool-disclosure">
              <summary>Simulated routes</summary>
              <RouteComparisonPanel />
            </details>
            {simulationActive && <>
              <p className="research-note">Select a simulated map node for its explanation and prediction spread.</p>
              <KpiStatsRow />
              <details className="tool-disclosure"><summary>Why is this area at risk?</summary><ExplainabilityPanel /></details>
              <details className="tool-disclosure"><summary>Prediction spread</summary><UncertaintyPanel /></details>
            </>}
            <HistoricalFloodTimeline />
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
