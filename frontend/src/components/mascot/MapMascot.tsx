import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, type AssistantOutlook, type AssistantPhrasing, type AssistantRouteContext, type DrivingOption } from "../../api/client";
import { collectMascotAlerts, type MascotAlert } from "../../map/assistantAlerts";
import { routeVertexDistances, type useDrivingPlanner } from "../../map/drivingPlanner";
import Icon from "../Icon";
import { expressions } from "./faces";
import ForecastBrief from "./ForecastBrief";
import TrafficBrief from "./TrafficBrief";
import "./mascot.css";

const MascotModel = lazy(() => import("./MascotModel"));
const outlookInterval = 5 * 60_000;
const voiceCooldown = 10 * 60_000;
type MascotPanel = "home" | "report" | "traffic";

function useMascotOutlook() {
  const [outlook, setOutlook] = useState<AssistantOutlook | null>(null);
  useEffect(() => {
    let request: AbortController | undefined;
    function refresh() {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      void api.getAssistantOutlook(controller.signal).then((value) => {
        if (!controller.signal.aborted) setOutlook(value);
      }).catch(() => {
        if (!controller.signal.aborted) setOutlook({ status: "unavailable" });
      });
    }
    refresh();
    const timer = window.setInterval(refresh, outlookInterval);
    return () => {
      window.clearInterval(timer);
      request?.abort();
    };
  }, []);
  return outlook;
}

function say(text: string) {
  const speech = window.speechSynthesis;
  if (!speech || typeof SpeechSynthesisUtterance === "undefined") return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speech.getVoices().filter((voice) => voice.localService && /^en(?:-|_)/i.test(voice.lang));
  utterance.voice = voices.find((voice) => /^en[-_]IN$/i.test(voice.lang)) ?? voices[0] ?? null;
  utterance.lang = utterance.voice?.lang ?? "en-IN";
  utterance.pitch = 1.12;
  utterance.rate = .94;
  speech.cancel();
  speech.speak(utterance);
}

function alertText(alert: MascotAlert, phrasing: AssistantPhrasing | null) {
  return phrasing?.styles[alert.kind] === "gentle" ? `A quick heads-up. ${alert.message}` : alert.message;
}

export default function MapMascot({ drive }: { drive: ReturnType<typeof useDrivingPlanner> }) {
  const outlook = useMascotOutlook();
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
  const voiceSupported = typeof window.speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
  const read = voiceSupported ? say : undefined;
  const { result, routeMatch, navigationLocation, navigationMode, selectedId } = drive;
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
    }, outlookInterval);
    return () => {
      window.clearInterval(timer);
      pending?.abort();
    };
  }, [route, useTomTom, navigationMode]);

  const alerts = useMemo(() => {
    const refreshed = refreshResult?.route === route ? refreshResult?.value : null;
    const trip = navigationMode === "active" && result && route && routeMatch && navigationLocation
      ? {
        response: refreshed ? {
          ...result, weather: refreshed.weather,
          traffic: refreshed.traffic ? { ...result.traffic, status: "ready" as const, checked_at: refreshed.traffic.checked_at } : result.traffic,
        } : result,
        route: refreshed ? {
          ...route, forecast_runoff_spans: refreshed.forecast_runoff_spans,
          traffic_segments: refreshed.traffic?.segments ?? route.traffic_segments,
        } : route,
        distances, match: routeMatch, location: navigationLocation,
      }
      : undefined;
    return collectMascotAlerts(outlook, Math.max(now, Date.now()), trip);
  }, [outlook, now, navigationMode, result, routeMatch, navigationLocation, route, distances, refreshResult]);

  const kinds = alerts.map((alert) => `${alert.kind}:${alert.face}`).join("|");
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
    const fresh = alerts.filter((alert) => time - (spoken.current.get(`${alert.kind}:${alert.face}`) ?? 0) > voiceCooldown);
    if (!fresh.length) return;
    fresh.forEach((alert) => spoken.current.set(`${alert.kind}:${alert.face}`, time));
    say(fresh.map((alert) => alertText(alert, phrasing)).join(" "));
  }, [alerts, voiceOn, phrasing]);

  function toggleVoice() {
    if (voiceOn) {
      window.speechSynthesis?.cancel();
      setVoiceOn(false);
      return;
    }
    const time = Date.now();
    alerts.forEach((alert) => spoken.current.set(`${alert.kind}:${alert.face}`, time));
    say(alerts.length ? alerts.map((alert) => alertText(alert, phrasing)).join(" ") : "Hi, I’m C X. Voice alerts are on.");
    setVoiceOn(true);
  }

  const status = outlook === null ? "Checking the three-hour forecast…"
    : outlook.status === "ready" ? "I’m watching the next three hours for modeled flood risk."
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
      {bubbleOpen && <div id="mascot-bubble" className="mascot-bubble" data-alert={alerts.length > 0} data-panel={panel}>
        <div className="mascot-bubble-heading">
          {panel !== "home" && <button className="mascot-close" type="button" aria-label="Back to CX menu"
            onClick={() => setPanel("home")}><Icon name="back" /></button>}
          <strong ref={heading} tabIndex={-1}>{panel === "report" ? "Forecast report" : panel === "traffic" ? "Traffic" : "CX"}</strong>
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
        </ul> : <>
          {manualOpen && <p className="mascot-greeting">Hi. What would you like to check?</p>}
          <p>{status}</p>
        </>}
        <div className="mascot-menu">
          <button type="button" onClick={() => setPanel("report")}><Icon name="calendar" />Forecast report</button>
          <button type="button" onClick={() => setPanel("traffic")}><Icon name="route" />Traffic</button>
        </div>
        <div className="mascot-actions">
          {voiceSupported && <button className="mascot-voice" type="button" aria-pressed={voiceOn} onClick={toggleVoice}>
            <Icon name={voiceOn ? "volume" : "mute"} />{voiceOn ? "Voice on" : "Enable voice"}
          </button>}
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
          if (bubbleOpen) closeBubble();
          else {
            setManualOpen(true);
            setPanel("home");
            read?.("Hi!");
          }
        }}>
        <Suspense fallback={<span className="mascot-fallback" aria-hidden="true"><i /><b>CX</b></span>}>
          <MascotModel pose={pose} />
        </Suspense>
      </button>
    </aside>
  );
}
