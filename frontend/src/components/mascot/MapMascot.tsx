import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, type AssistantPhrasing, type AssistantRouteContext, type CityFloodResponse, type DrivingOption } from "../../api/client";
import { collectMascotAlerts, scenarioRouteAlert, type MascotAlert } from "../../map/assistantAlerts";
import { assistantRefreshMs } from "../../map/assistantOutlook";
import { routeVertexDistances, type useDrivingPlanner } from "../../map/drivingPlanner";
import { HEAVY_RAIN_SCREEN_MM, HIGH_TEMPERATURE_SCREEN_C, scanIndiaCityForecasts, type IndiaCityScanResult } from "../../map/indiaCityForecast";
import { loadIndiaCities } from "../../map/indiaCities";
import Icon from "../Icon";
import { expressions } from "./faces";
import ForecastBrief from "./ForecastBrief";
import TrafficBrief from "./TrafficBrief";
import { useCXVoice } from "./cxVoice";
import { useCXCompanion } from "./useCXCompanion";
import "./mascot.css";

const MascotModel = lazy(() => import("./MascotModel"));
const voiceCooldown = 10 * 60_000;
type MascotPanel = "home" | "report" | "traffic";

function alertText(alert: MascotAlert, phrasing: AssistantPhrasing | null) {
  const style = alert.kind === "city_flood" || alert.kind === "route_rain" || alert.kind === "traffic"
    ? phrasing?.styles[alert.kind] : undefined;
  return style === "gentle" ? `A quick heads-up. ${alert.message}` : alert.message;
}

function alertKey(alert: MascotAlert) {
  return alert.key ?? `${alert.kind}:${alert.face}`;
}

export default function MapMascot({ drive, cityFlood, weatherLocation, weatherLocationName }: {
  drive: ReturnType<typeof useDrivingPlanner>; cityFlood: CityFloodResponse | null;
  weatherLocation: { lat: number; lng: number };
  weatherLocationName: string;
}) {
  const weatherLatitude = weatherLocation.lat;
  const weatherLongitude = weatherLocation.lng;
  const [phrasing, setPhrasing] = useState<AssistantPhrasing | null>(null);
  const [now, setNow] = useState(Date.now);
  const [voiceOn, setVoiceOn] = useState(false);
  const [locationAlertsOn, setLocationAlertsOn] = useState(false);
  const [locationAlerts, setLocationAlerts] = useState<MascotAlert[]>([]);
  const [locationAlertStatus, setLocationAlertStatus] = useState("Location alerts are off.");
  const [indiaScan, setIndiaScan] = useState<IndiaCityScanResult | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState({ checked: 0, total: 0 });
  const [scanError, setScanError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [panel, setPanel] = useState<MascotPanel>("home");
  const [dismissed, setDismissed] = useState("");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [refreshResult, setRefreshResult] = useState<{
    route: DrivingOption; value: Extract<AssistantRouteContext, { status: "ready" }>;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const startVoiceButton = useRef<HTMLButtonElement>(null);
  const stopVoiceButton = useRef<HTMLButtonElement>(null);
  const wasTalking = useRef(false);
  const heading = useRef<HTMLElement>(null);
  const spoken = useRef(new Map<string, number>());
  const scanRequest = useRef<AbortController | null>(null);
  const { read, voices, voiceId, setVoiceId } = useCXVoice();
  const { result, routeMatch, navigationLocation, navigationMode, selectedId, scenario, scenarioRoutes, liveTrafficSegments, trafficFlowCheckedAt } = drive;
  const route = result?.routes.find((option) => option.id === selectedId);
  const useTomTom = result?.source === "TomTom Routing";
  const distances = useMemo(() => route ? routeVertexDistances(route.coordinates) : [], [route]);
  function setAlertMonitoring(enabled: boolean) {
    setLocationAlertsOn(enabled);
    if (enabled) setVoiceOn(true);
    return enabled
      ? `24-hour weather and voice alerts are on for ${weatherLocationName}.`
      : "Weather alerts are off.";
  }
  const companion = useCXCompanion(drive, route, distances, read, weatherLocation, (enabled) => {
    return setAlertMonitoring(enabled);
  });
  const { active: talking, canAnnounce, speak, transcript } = companion;
  const voiceStatus = companion.phase === "listening" ? (companion.awake ? "Listening for your request" : "Listening · say “Hello CX”")
    : companion.phase === "working" ? "Working on your request…"
      : companion.phase === "speaking" ? "CX is speaking…" : "Starting the microphone…";

  useEffect(() => {
    const controller = new AbortController();
    void api.getAssistantPhrasing(controller.signal).then((value) => {
      if (!controller.signal.aborted) setPhrasing(value);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!locationAlertsOn) {
      setLocationAlerts([]);
      setLocationAlertStatus("Location alerts are off.");
      return;
    }
    let controller: AbortController | null = null;
    async function checkLocation() {
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      setLocationAlertStatus(`Checking the next 24 hours for ${weatherLocationName}…`);
      try {
        const forecast = await api.getWeatherReport(request.signal, { lat: weatherLatitude, lng: weatherLongitude });
        if (request.signal.aborted) return;
        if (forecast.status !== "ready" || forecast.hourly_forecast.length < 24) {
          setLocationAlerts([]);
          setLocationAlertStatus(`The 24-hour forecast for ${weatherLocationName} is unavailable.`);
          return;
        }
        const nextDay = forecast.hourly_forecast.slice(0, 24);
        const rainfall = nextDay.reduce((total, hour) => total + hour.precipitation_mm, 0);
        const maximum = Math.max(...nextDay.map((hour) => hour.air_temperature_c));
        const alerts: MascotAlert[] = [];
        if (rainfall >= HEAVY_RAIN_SCREEN_MM) alerts.push({
          kind: "city_flood", face: "rain", key: `local-rain:${weatherLocationName}:${Math.floor(Date.now() / 900_000)}`,
          title: `Heavy rain forecast near ${weatherLocationName}`,
          message: `${rainfall.toFixed(1)} mm of rain is forecast over 24 hours. This is a rainfall screening proxy, not a flood-depth prediction or official warning.`,
        });
        if (maximum >= HIGH_TEMPERATURE_SCREEN_C) alerts.push({
          kind: "heat", face: "watchful", key: `local-heat:${weatherLocationName}:${Math.floor(Date.now() / 900_000)}`,
          title: `High-temperature forecast near ${weatherLocationName}`,
          message: `The forecast reaches ${maximum.toFixed(1)} °C in the next 24 hours. This simple temperature screen is not an IMD heatwave assessment or official warning.`,
        });
        setLocationAlerts(alerts);
        setLocationAlertStatus(alerts.length
          ? `${alerts.length} weather screening alert${alerts.length === 1 ? "" : "s"} for ${weatherLocationName}.`
          : `No heavy-rainfall or 40 °C screening threshold is forecast for ${weatherLocationName} in the next 24 hours.`);
      } catch {
        if (!request.signal.aborted) {
          setLocationAlerts([]);
          setLocationAlertStatus(`The 24-hour forecast for ${weatherLocationName} could not be checked. Try again shortly.`);
        }
      }
    }
    void checkLocation();
    const timer = window.setInterval(() => { void checkLocation(); }, 15 * 60_000);
    return () => {
      window.clearInterval(timer);
      controller?.abort();
    };
  }, [locationAlertsOn, weatherLatitude, weatherLongitude, weatherLocationName]);

  async function scanIndianCities() {
    scanRequest.current?.abort();
    const controller = new AbortController();
    scanRequest.current = controller;
    setPanel("home");
    setManualOpen(true);
    setScanLoading(true);
    setScanError(null);
    setIndiaScan(null);
    setScanProgress({ checked: 0, total: 0 });
    try {
      const catalog = await loadIndiaCities(controller.signal);
      if (controller.signal.aborted) return;
      setScanProgress({ checked: 0, total: catalog.places.length });
      const result = await scanIndiaCityForecasts(catalog.places, controller.signal, (checked, total) => {
        if (!controller.signal.aborted) setScanProgress({ checked, total });
      });
      if (controller.signal.aborted) return;
      setIndiaScan(result);
      if (result.unavailable) setScanError(`${result.unavailable.toLocaleString("en-IN")} city forecasts could not be checked.`);
      if (voiceOn && read) {
        const rain = result.alerts.filter((alert) => alert.heavyRain).length;
        const heat = result.alerts.filter((alert) => alert.highTemperature).length;
        read(`India city scan checked ${result.checked.toLocaleString("en-IN")} places. ${rain} heavy rainfall screens and ${heat} high temperature screens were found.${result.unavailable ? ` ${result.unavailable} forecasts were unavailable.` : " This is not an official all-clear."}`);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setScanError(reason instanceof Error ? reason.message : "India city scan could not be completed.");
    } finally {
      if (scanRequest.current === controller) {
        scanRequest.current = null;
        setScanLoading(false);
      }
    }
  }

  useEffect(() => () => scanRequest.current?.abort(), []);

  useEffect(() => {
    if (navigationMode !== "active" || !route) return;
    let pending: AbortController | undefined;
    const timer = window.setInterval(() => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      void api.refreshAssistantRoute(route.coordinates, useTomTom, request.signal).then((value) => {
        if (!request.signal.aborted && value.status === "ready") {
          setRefreshResult((previous) => ({
            route,
            value: { ...value, traffic: value.traffic ?? (previous?.route === route ? previous.value.traffic : null) },
          }));
        }
      }).catch(() => {});
    }, assistantRefreshMs);
    return () => {
      window.clearInterval(timer);
      pending?.abort();
    };
  }, [route, useTomTom, navigationMode]);

  const scenarioAlert = useMemo<MascotAlert | null>(() => {
    if (!scenario) return null;
    const { rainfallMm, floodDemo, revision } = scenario;
    const count = cityFlood?.status === "ready" ? new Set(cityFlood.cells.filter((cell) => (cell.screen_mm ?? 0) >= 5)
      .map((cell) => cell.id.replace(/:[^:]+$/, ""))).size : null;
    const label = floodDemo ? "Flood demo" : "Rainfall simulation";
    return {
      kind: "scenario_flood", face: floodDemo || (count ?? 0) > 0 ? "flood" : "rain", key: `scenario:${revision}`,
      title: `${label} active`,
      message: `${label} is running with ${Number(rainfallMm.toFixed(1))} millimetres of simulated rain. ${cityFlood?.status === "unavailable"
        ? "City runoff screening is unavailable." : count === null ? "I'm checking the city runoff grid."
          : count === 0 ? "No city cells reach five millimetres of screened runoff."
            : `${count.toLocaleString("en-IN")} city grid cells reach at least five millimetres of modeled runoff.`}`,
    };
  }, [scenario, cityFlood]);

  const alerts = useMemo(() => {
    const refreshed = refreshResult?.route === route ? refreshResult?.value : null;
    const trip = (navigationMode === "active" || navigationMode === "simulating") && result && route && routeMatch && navigationLocation
      ? {
        response: {
          ...result, weather: refreshed?.weather ?? result.weather,
          traffic: { ...result.traffic, checked_at: refreshed?.traffic?.checked_at ?? trafficFlowCheckedAt ?? result.traffic.checked_at },
        },
        route: refreshed ? {
          ...route, forecast_runoff_spans: refreshed.forecast_runoff_spans,
          traffic_segments: refreshed.traffic?.segments ?? liveTrafficSegments ?? route.traffic_segments,
        } : { ...route, traffic_segments: liveTrafficSegments ?? route.traffic_segments },
        distances, match: routeMatch, location: navigationLocation,
      }
      : undefined;
    const live = [...locationAlerts, ...collectMascotAlerts(null, Math.max(now, Date.now()), trip)];
    const exposure = scenarioRoutes.find((entry) => entry.id === selectedId);
    const demo = scenario && exposure && routeMatch && navigationMode === "simulating"
      ? scenarioRouteAlert(exposure.spans, routeMatch, scenario.revision) : null;
    return [...(demo ? [demo] : []), ...(scenarioAlert ? [scenarioAlert] : []), ...live];
  }, [locationAlerts, now, navigationMode, result, routeMatch, navigationLocation, route, distances, refreshResult, liveTrafficSegments,
    scenario, scenarioRoutes, selectedId, scenarioAlert, trafficFlowCheckedAt]);

  const kinds = alerts.map(alertKey).join("|");
  const automaticBubble = kinds !== "" && kinds !== dismissed;
  const bubbleOpen = manualOpen || automaticBubble;
  const face = alerts[0]?.face ?? (locationAlertsOn ? "happy" : "watchful");
  const defaultPose = expressions.find((pose) => pose.family === face) ?? expressions[0];
  const pose = !alerts.length && bubbleOpen && panel === "home" && previewIndex !== null ? expressions[previewIndex] : defaultPose;

  useEffect(() => {
    if (panel !== "home") heading.current?.focus();
  }, [panel]);

  useEffect(() => {
    if (talking) {
      wasTalking.current = true;
      stopVoiceButton.current?.focus();
    } else if (wasTalking.current) {
      wasTalking.current = false;
      if (bubbleOpen && panel === "home") startVoiceButton.current?.focus();
      else if (bubbleOpen) heading.current?.focus();
    }
  }, [talking, bubbleOpen, panel]);

  useEffect(() => {
    if (!kinds) setDismissed("");
  }, [kinds]);

  useEffect(() => {
    if (!voiceOn) return;
    if (talking && !canAnnounce) return;
    const time = Date.now();
    const fresh = alerts.filter((alert) => time - (spoken.current.get(alertKey(alert)) ?? 0) > voiceCooldown);
    if (!fresh.length) return;
    const text = fresh.map((alert) => alertText(alert, phrasing)).join(" ");
    if (talking && !speak(text)) return;
    if (!talking) read?.(text);
    fresh.forEach((alert) => spoken.current.set(alertKey(alert), time));
  }, [alerts, voiceOn, phrasing, read, talking, canAnnounce, speak]);

  function toggleVoice() {
    if (voiceOn) {
      if (!talking) window.speechSynthesis?.cancel();
      setVoiceOn(false);
      return;
    }
    const time = Date.now();
    alerts.forEach((alert) => spoken.current.set(alertKey(alert), time));
    if (!talking) read?.(alerts.length ? alerts.map((alert) => alertText(alert, phrasing)).join(" ") : "Hi, I’m C X. Voice alerts are on.");
    setVoiceOn(true);
  }

  const status = locationAlertStatus;

  function closeBubble() {
    if (talking) companion.stop();
    setManualOpen(false);
    setDismissed(kinds);
    setPanel("home");
    trigger.current?.focus();
  }

  const speakInPanel = talking ? (text: string) => { if (canAnnounce) speak(text); } : read;

  return (
    <aside className="map-mascot" aria-label="CX map assistant" onKeyDown={(event) => {
      if (event.key === "Escape" && bubbleOpen && !event.defaultPrevented) {
        event.preventDefault();
        closeBubble();
      }
    }}>
      <div className="sr-only" aria-live="polite">{alerts.map((alert) => alert.title).join(". ")}</div>
      {bubbleOpen && <div id="mascot-bubble" className="mascot-bubble" data-alert={alerts.length > 0} data-panel={panel}
        data-compact={automaticBubble && !manualOpen && panel === "home"}>
        <div className="mascot-bubble-heading">
          {panel !== "home" && <button className="mascot-close" type="button" aria-label="Back to CX menu"
            onClick={() => setPanel("home")}><Icon name="back" /></button>}
          <strong ref={heading} tabIndex={-1}>{panel === "report" ? "Forecast report" : panel === "traffic" ? "Traffic" : "CX"}</strong>
          <button className="mascot-close" type="button" aria-label="Close CX bubble" onClick={closeBubble}><Icon name="close" /></button>
        </div>
        {panel === "report" && <ForecastBrief key={`${weatherLatitude},${weatherLongitude}`} onRead={speakInPanel} autoSpeak={voiceOn && !talking}
          location={weatherLocation} locationName={weatherLocationName} />}
        {panel === "traffic" && <TrafficBrief drive={drive} onRead={speakInPanel} />}
        {panel === "home" && <>
        {alerts.length ? <ul className="mascot-alerts">
          {alerts.map((alert) => <li key={alert.kind}>
            <strong>{alert.title}</strong>
            <p>{alertText(alert, phrasing)}</p>
          </li>)}
        </ul> : <>
          {manualOpen && <p className="mascot-greeting">Hi. What would you like to check?</p>}
          <p>{status}</p>
        </>}
        <section className="mascot-voice-panel" aria-label="Voice assistant">
          <div className="mascot-voice-panel-heading">
            <strong>{talking ? voiceStatus : "Talk to CX"}</strong>
            {talking && <span className="voice-live-indicator" aria-hidden="true" />}
          </div>
          {companion.supported && !talking && <button ref={startVoiceButton} className="mascot-voice mascot-talk" type="button"
            aria-describedby="cx-mic-help" onClick={companion.start}>
            <Icon name="microphone" />{companion.error ? "Try voice again" : "Start talking"}
          </button>}
          {!companion.supported && <p role="status">Voice input or speech playback is not available in this browser. You can still use the map and forecast controls.</p>}
          {talking && <>
            <p className="voice-session-hint">{voiceStatus}{companion.phase === "listening" && !companion.awake
              ? " to begin. Then ask for weather, rain, or directions." : ""}</p>
            {transcript && <p className="voice-transcript" aria-live="polite"><strong>Heard:</strong> {transcript}</p>}
            <button ref={stopVoiceButton} type="button" className="mascot-voice mascot-stop" aria-label="Stop listening"
              onClick={companion.stop}><Icon name="close" />Stop listening</button>
          </>}
          {companion.error && <p className="mascot-voice-error" role="alert">{companion.error}</p>}
          <p id="cx-mic-help" className="mascot-voice-help">Say “Hello CX,” then ask one thing. Try “weather in Mysuru” or “navigate to Lalbagh.” Your browser may process microphone audio online; CityShield receives recognized words. Say “Stop listening” to end.</p>
        </section>
        <div className="mascot-menu">
          <button type="button" onClick={() => setPanel("report")}><Icon name="calendar" />Forecast report</button>
          <button type="button" onClick={() => setPanel("traffic")}><Icon name="route" />Traffic</button>
        </div>
        <div className="mascot-actions">
          <button type="button" className="mascot-voice" aria-pressed={locationAlertsOn}
            onClick={() => setAlertMonitoring(!locationAlertsOn)}>
            {locationAlertsOn ? `Alerts on · ${weatherLocationName}` : `Turn alerts on · ${weatherLocationName}`}
          </button>
          <button type="button" className="mascot-voice" disabled={scanLoading} onClick={() => void scanIndianCities()}>
            {scanLoading ? "Scanning Indian cities…" : "Scan Indian cities & towns"}
          </button>
          {scanLoading && <div className="mascot-scan-progress" role="status">
            <span>{scanProgress.total ? `Checking ${scanProgress.checked.toLocaleString("en-IN")} of ${scanProgress.total.toLocaleString("en-IN")} places` : "Loading the India city list…"}</span>
            {scanProgress.total > 0 && <progress max={scanProgress.total} value={scanProgress.checked} aria-label="India city forecast scan progress" />}
            <button type="button" className="mascot-voice" onClick={() => scanRequest.current?.abort()}>Cancel scan</button>
          </div>}
          {scanError && <p className="mascot-scan-error" role="status">{scanError}</p>}
          {indiaScan && <div className="mascot-scan-results" aria-label="India city forecast screening results">
            <p role="status">Checked {indiaScan.checked.toLocaleString("en-IN")} of {indiaScan.places.toLocaleString("en-IN")} GeoNames places.
              {indiaScan.unavailable ? ` ${indiaScan.unavailable.toLocaleString("en-IN")} were unavailable.` : ""}</p>
            {indiaScan.alerts.length ? <ul className="mascot-alerts">
              {indiaScan.alerts.slice(0, 30).map((alert) => <li key={`${alert.city.id}:${alert.heavyRain ? "rain" : "heat"}`}>
                <strong>{alert.city.name}, {alert.city.state}</strong>
                <p>{[
                  alert.heavyRain ? `${alert.rainfall24hMm.toFixed(1)} mm forecast rain in 24 hours` : "",
                  alert.highTemperature ? `${alert.maximumTemperature24hC.toFixed(1)} °C forecast maximum` : "",
                ].filter(Boolean).join(" · ")}</p>
              </li>)}
              {indiaScan.alerts.length > 30 && <li><p>And {indiaScan.alerts.length - 30} more places crossed a screen.</p></li>}
            </ul> : <p>No 64.5 mm rainfall or 40 °C temperature screening threshold was found in the checked forecasts. This is not an official all-clear.</p>}
            <p className="mascot-scan-caveat">Rainfall does not predict inundation. Temperature screens are not IMD heatwave warnings. Check official local alerts.</p>
          </div>}
          <p className="mascot-scan-caveat">Catalog: cities with population over 500 or administrative seats; some smaller places may be missing. The values are forecast estimates, not official warnings.</p>
        </div>
        {!manualOpen && <button type="button" className="mascot-voice mascot-expand" onClick={() => setManualOpen(true)}>CX options</button>}
        <div className="mascot-actions">
          {read && <button className="mascot-voice" type="button" aria-pressed={voiceOn} onClick={toggleVoice}>
            <Icon name={voiceOn ? "volume" : "mute"} />{voiceOn ? "Spoken alerts on" : "Enable spoken alerts"}
          </button>}
          {speakInPanel && alerts.length > 0 && <button className="mascot-voice" type="button"
            onClick={() => speakInPanel(alerts.map((alert) => alertText(alert, phrasing)).join(" "))}>Read alerts</button>}
          {read && voices.length > 0 && <details className="mascot-expressions mascot-voice-settings">
            <summary>Choose voice</summary>
            <label className="sr-only" htmlFor="mascot-voice-choice">CX voice</label>
            <select id="mascot-voice-choice" value={voiceId} onChange={(event) => setVoiceId(event.target.value)}>
              <option value="">Automatic · {voices[0].name}</option>
              {voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
            </select>
            <button type="button" className="mascot-voice" onClick={() => speakInPanel?.("Hi, I’m C X. I’ll keep you updated on rain and traffic.")}>Preview voice</button>
          </details>}
          {!alerts.length && <details className="mascot-expressions">
            <summary>Expressions</summary>
            <label className="sr-only" htmlFor="mascot-expression">Preview a face expression</label>
            <select id="mascot-expression" value={previewIndex ?? expressions.indexOf(defaultPose)}
              onChange={(event) => setPreviewIndex(Number(event.target.value))}>
              {expressions.map((expression, index) => <option key={expression.label} value={index}>{expression.label}</option>)}
            </select>
          </details>}
        </div>
        </>}
      </div>}
      <button ref={trigger} className="mascot-trigger" type="button" aria-label="CX assistant"
        aria-controls={bubbleOpen ? "mascot-bubble" : undefined} aria-expanded={bubbleOpen}
        data-expression={pose.label} onClick={() => {
          if (automaticBubble && !manualOpen && panel === "home") setManualOpen(true);
          else if (bubbleOpen) closeBubble();
          else {
            setManualOpen(true);
            setPanel("home");
            if (!talking) read?.("Hi!");
          }
        }}>
        <Suspense fallback={<span className="mascot-fallback" aria-hidden="true"><i /><b>CX</b></span>}>
          <MascotModel pose={pose} />
        </Suspense>
      </button>
      {talking && panel !== "home" && <button type="button" className="mascot-mic-state" aria-label="Stop listening" onClick={companion.stop}>
        <Icon name="microphone" /><span role="status">{voiceStatus}</span>
      </button>}
    </aside>
  );
}
