import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, type AssistantOutlook, type AssistantPhrasing, type AssistantRouteContext, type CityFloodResponse, type DrivingOption } from "../../api/client";
import { collectMascotAlerts, scenarioRouteAlert, type MascotAlert } from "../../map/assistantAlerts";
import { assistantRefreshMs } from "../../map/assistantOutlook";
import { routeVertexDistances, type useDrivingPlanner } from "../../map/drivingPlanner";
import Icon from "../Icon";
import { expressions } from "./faces";
import ForecastBrief from "./ForecastBrief";
import TrafficBrief from "./TrafficBrief";
import { useCXVoice } from "./cxVoice";
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

export default function MapMascot({ drive, outlook, cityFlood }: {
  drive: ReturnType<typeof useDrivingPlanner>; outlook: AssistantOutlook | null; cityFlood: CityFloodResponse | null;
}) {
  const [phrasing, setPhrasing] = useState<AssistantPhrasing | null>(null);
  const [now, setNow] = useState(Date.now);
  const [voiceOn, setVoiceOn] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [panel, setPanel] = useState<MascotPanel>("home");
  const [dismissed, setDismissed] = useState("");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [refreshResult, setRefreshResult] = useState<{
    route: DrivingOption; value: Extract<AssistantRouteContext, { status: "ready" }>;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLElement>(null);
  const spoken = useRef(new Map<string, number>());
  const { read, voices, voiceId, setVoiceId } = useCXVoice();
  const { result, routeMatch, navigationLocation, navigationMode, selectedId, scenario, scenarioRoutes, liveTrafficSegments, trafficFlowCheckedAt } = drive;
  const route = result?.routes.find((option) => option.id === selectedId);
  const useTomTom = result?.source === "TomTom Routing";
  const distances = useMemo(() => route ? routeVertexDistances(route.coordinates) : [], [route]);

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
    const live = collectMascotAlerts(outlook, Math.max(now, Date.now()), trip);
    const exposure = scenarioRoutes.find((entry) => entry.id === selectedId);
    const demo = scenario && exposure && routeMatch && navigationMode === "simulating"
      ? scenarioRouteAlert(exposure.spans, routeMatch, scenario.revision) : null;
    return [...(demo ? [demo] : []), ...(scenarioAlert ? [scenarioAlert] : []), ...live];
  }, [outlook, now, navigationMode, result, routeMatch, navigationLocation, route, distances, refreshResult, liveTrafficSegments,
    scenario, scenarioRoutes, selectedId, scenarioAlert, trafficFlowCheckedAt]);

  const kinds = alerts.map(alertKey).join("|");
  const automaticBubble = kinds !== "" && kinds !== dismissed;
  const bubbleOpen = manualOpen || automaticBubble;
  const face = alerts[0]?.face ?? (outlook?.status === "ready" ? "happy" : "watchful");
  const defaultPose = expressions.find((pose) => pose.family === face) ?? expressions[0];
  const pose = !alerts.length && bubbleOpen && panel === "home" && previewIndex !== null ? expressions[previewIndex] : defaultPose;

  useEffect(() => {
    if (panel !== "home") heading.current?.focus();
  }, [panel]);

  useEffect(() => {
    if (!kinds) setDismissed("");
  }, [kinds]);

  useEffect(() => {
    if (!voiceOn) return;
    const time = Date.now();
    const fresh = alerts.filter((alert) => time - (spoken.current.get(alertKey(alert)) ?? 0) > voiceCooldown);
    if (!fresh.length) return;
    fresh.forEach((alert) => spoken.current.set(alertKey(alert), time));
    read?.(fresh.map((alert) => alertText(alert, phrasing)).join(" "));
  }, [alerts, voiceOn, phrasing, read]);

  function toggleVoice() {
    if (voiceOn) {
      window.speechSynthesis?.cancel();
      setVoiceOn(false);
      return;
    }
    const time = Date.now();
    alerts.forEach((alert) => spoken.current.set(alertKey(alert), time));
    read?.(alerts.length ? alerts.map((alert) => alertText(alert, phrasing)).join(" ") : "Hi, I’m C X. Voice alerts are on.");
    setVoiceOn(true);
  }

  const status = outlook === null ? "Checking the three-hour forecast…"
    : outlook.status === "ready" ? "Open a forecast or check conditions along a route."
      : "The city outlook is unavailable right now.";

  function closeBubble() {
    setManualOpen(false);
    setDismissed(kinds);
    setPanel("home");
    trigger.current?.focus();
  }

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
          <strong ref={heading} tabIndex={-1}>{panel === "report" ? "Forecast report" : panel === "traffic" ? "Traffic" : "Forecast and route assistant"}</strong>
          <button className="mascot-close" type="button" aria-label="Close CX bubble" onClick={closeBubble}><Icon name="close" /></button>
        </div>
        {panel === "report" && <ForecastBrief onRead={read} autoSpeak={voiceOn} />}
        {panel === "traffic" && <TrafficBrief drive={drive} onRead={read} />}
        {panel === "home" && <>
        {alerts.length ? <ul className="mascot-alerts">
          {alerts.map((alert) => <li key={alert.kind}>
            <strong>{alert.title}</strong>
            <p>{alertText(alert, phrasing)}</p>
          </li>)}
        </ul> : <p>{status}</p>}
        <div className="mascot-menu">
          <button type="button" onClick={() => setPanel("report")}><Icon name="calendar" />Forecast report</button>
          <button type="button" onClick={() => setPanel("traffic")}><Icon name="route" />Traffic</button>
        </div>
        {!manualOpen && <button type="button" className="mascot-voice mascot-expand" onClick={() => setManualOpen(true)}>CX options</button>}
        <div className="mascot-actions">
          {read && <button className="mascot-voice" type="button" aria-pressed={voiceOn} onClick={toggleVoice}>
            <Icon name={voiceOn ? "volume" : "mute"} />{voiceOn ? "Voice on" : "Enable voice"}
          </button>}
          {read && alerts.length > 0 && <button className="mascot-voice" type="button"
            onClick={() => read(alerts.map((alert) => alertText(alert, phrasing)).join(" "))}>Read alerts</button>}
          {read && voices.length > 0 && <details className="mascot-expressions mascot-voice-settings">
            <summary>Choose voice</summary>
            <label className="sr-only" htmlFor="mascot-voice-choice">CX voice</label>
            <select id="mascot-voice-choice" value={voiceId} onChange={(event) => setVoiceId(event.target.value)}>
              <option value="">Automatic · {voices[0].name}</option>
              {voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
            </select>
            <button type="button" className="mascot-voice" onClick={() => read("Hi, I’m C X. I’ll keep you updated on rain and traffic.")}>Preview voice</button>
          </details>}
          {!alerts.length && <details className="mascot-expressions">
            <summary>Expressions</summary>
            <label className="sr-only" htmlFor="mascot-expression">Preview a face expression</label>
            <select id="mascot-expression" value={previewIndex ?? expressions.indexOf(defaultPose)}
              onChange={(event) => setPreviewIndex(Number(event.target.value))}>
              {expressions.map((expression, index) => <option key={expression.label} value={index}>{expression.label}</option>)}
            </select>
            {previewIndex !== null && <div className="mascot-expression-preview">
              <Suspense fallback={<p>Loading preview…</p>}><MascotModel pose={pose} /></Suspense>
            </div>}
          </details>}
        </div>
        </>}
      </div>}
      <button ref={trigger} className="mascot-trigger" type="button" aria-label="CX assistant"
        aria-controls={bubbleOpen ? "mascot-bubble" : undefined} aria-expanded={bubbleOpen}
        onClick={() => {
          if (automaticBubble && !manualOpen && panel === "home") setManualOpen(true);
          else if (bubbleOpen) closeBubble();
          else {
            setManualOpen(true);
            setPanel("home");
            read?.("Hi!");
          }
        }}>
        <Icon name="info" /><span>Assistant</span>
      </button>
    </aside>
  );
}
