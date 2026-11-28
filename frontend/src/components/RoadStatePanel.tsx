import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CityFloodResponse, type LatLng, type WeatherAvailabilityResponse } from "../api/client";
import bengaluruStorm2020 from "../data/bengaluru-storm-2020.json";
import HistoricalFloodTimeline from "./HistoricalFloodTimeline";

const BENGALURU: LatLng = { lat: 12.97194, lng: 77.59369 };
const FORECAST_WINDOWS = [3, 6, 12, 24, 48] as const;
type RoadStateMode = "current" | "forecast" | "hypothetical" | "history";

function readyRainfall(value: WeatherAvailabilityResponse | null) {
  return value?.status === "ready" ? value.recent_rain_mm + value.upcoming_rain_mm : null;
}

export default function RoadStatePanel({ onScreenChange, runRequest = 0 }: {
  onScreenChange: (value: CityFloodResponse | null) => void;
  runRequest?: number;
}) {
  const [mode, setMode] = useState<RoadStateMode>("current");
  const [current, setCurrent] = useState<WeatherAvailabilityResponse | null>(null);
  const [forecast, setForecast] = useState<Awaited<ReturnType<typeof api.getWeatherReport>> | null>(null);
  const [hours, setHours] = useState<(typeof FORECAST_WINDOWS)[number]>(24);
  const [hypotheticalMm, setHypotheticalMm] = useState("50");
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [loadingScreen, setLoadingScreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CityFloodResponse | null>(null);
  const [resultLabel, setResultLabel] = useState<string | null>(null);
  const [weatherRetry, setWeatherRetry] = useState(0);
  const screenRequest = useRef<AbortController | null>(null);
  const lastAutoRunRequest = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (runRequest === 0 || modeRef.current === "current") return;
    setMode("current");
    setCurrent(null);
    setWeatherRetry((count) => count + 1);
  }, [runRequest]);

  useEffect(() => {
    onScreenChange(null);
    setResult(null);
    setError(null);
    setLoadingWeather(false);
    setLoadingScreen(false);
    if (mode === "history" || mode === "hypothetical") return undefined;

    const controller = new AbortController();
    setLoadingWeather(true);
    const load = mode === "current"
      ? api.getWeatherNowcast(controller.signal, BENGALURU).then(setCurrent)
      : api.getWeatherReport(controller.signal, BENGALURU).then(setForecast);
    void load.catch(() => {
      if (!controller.signal.aborted) setError(mode === "current"
        ? "Current rainfall data could not load. Retry or choose a what-if amount."
        : "The Bengaluru forecast could not load. Retry or choose a what-if amount.");
    }).finally(() => { if (!controller.signal.aborted) setLoadingWeather(false); });
    return () => {
      controller.abort();
      screenRequest.current?.abort();
      screenRequest.current = null;
    };
  }, [mode, onScreenChange, weatherRetry]);

  const forecastMm = useMemo(() => forecast?.status === "ready"
    ? forecast.hourly_forecast.slice(0, hours).reduce((sum, hour) => sum + hour.precipitation_mm, 0)
    : null, [forecast, hours]);
  const rainfallMm = mode === "current" ? readyRainfall(current)
    : mode === "forecast" ? forecastMm
      : mode === "hypothetical" && hypotheticalMm.trim() !== "" && Number.isFinite(Number(hypotheticalMm))
        ? Number(hypotheticalMm) : null;
  const rainfallLabel = mode === "current" ? "Recent plus upcoming rain"
    : mode === "forecast" ? `Next ${hours} forecast hours`
      : mode === "history" ? "Historical Kengeri gauge total"
        : "User-set rainfall total";

  const runScreening = useCallback(async (amountMm = rainfallMm) => {
    if (amountMm === null || loadingScreen) return;
    setLoadingScreen(true);
    setError(null);
    setResult(null);
    setResultLabel(rainfallLabel);
    onScreenChange(null);
    screenRequest.current?.abort();
    const controller = new AbortController();
    screenRequest.current = controller;
    try {
      const value = await api.getCityFlood(amountMm, controller.signal);
      if (controller.signal.aborted) return;
      setResult(value);
      onScreenChange(value);
      if (value.status === "unavailable") setError(value.message);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Road screening could not run. Try again.");
    } finally {
      if (!controller.signal.aborted) setLoadingScreen(false);
      if (screenRequest.current === controller) screenRequest.current = null;
    }
  }, [loadingScreen, onScreenChange, rainfallLabel, rainfallMm]);

  useEffect(() => {
    if (runRequest <= lastAutoRunRequest.current || mode !== "current" || loadingWeather || current?.status !== "ready") return;
    lastAutoRunRequest.current = runRequest;
    void runScreening(current.recent_rain_mm + current.upcoming_rain_mm);
  }, [current, loadingWeather, mode, runRequest, runScreening]);

  function changeMode(next: RoadStateMode) {
    setMode(next);
    setError(null);
  }

  return <section className="road-state" aria-labelledby="road-state-heading">
    <h3 id="road-state-heading">Bengaluru road screening</h3>
    <p>Mapped roads are shaded by a terrain runoff screen. Darker segments indicate higher screened runoff; unmarked roads have no screened crossing in the current view. This is not a measured flood probability or confirmed road closure.</p>

    <fieldset className="road-state-modes">
      <legend>Data for screening</legend>
      {([
        ["current", "Current rain"], ["forecast", "Forecast"], ["hypothetical", "What-if"], ["history", "History"],
      ] as const).map(([value, label]) => <label key={value}>
        <input type="radio" name="road-state-mode" value={value} checked={mode === value}
          onChange={() => changeMode(value)} />
        <span>{label}</span>
      </label>)}
    </fieldset>

    {mode === "current" && <div className="road-state-data" aria-live="polite">
      {loadingWeather ? <p role="status">Loading current rainfall…</p> : current?.status === "ready" ? <>
        <strong>{rainfallMm?.toFixed(1)} mm</strong>
        <span>Recent {current.recent_rain_mm.toFixed(1)} mm + upcoming {current.upcoming_rain_mm.toFixed(1)} mm</span>
        <small>Rain window retrieved {new Date(current.provenance.retrieved_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</small>
      </> : <p>Current rainfall is unavailable. Retry or switch to a what-if amount.</p>}
      <button type="button" className="secondary-button" disabled={loadingWeather} onClick={() => setWeatherRetry((value) => value + 1)}>Refresh current rain</button>
    </div>}

    {mode === "forecast" && <div className="road-state-data" aria-live="polite">
      {loadingWeather ? <p role="status">Loading Bengaluru forecast…</p> : forecast?.status === "ready" ? <>
        <label htmlFor="road-state-hours">Forecast window</label>
        <select id="road-state-hours" value={hours} onChange={(event) => setHours(Number(event.target.value) as typeof hours)}>
          {FORECAST_WINDOWS.map((windowHours) => <option key={windowHours} value={windowHours}>{windowHours} hours</option>)}
        </select>
        <strong>{forecastMm?.toFixed(1)} mm</strong>
        <span>Forecast precipitation in the selected window</span>
        <small>Retrieved {new Date(forecast.provenance.retrieved_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</small>
      </> : <p>Bengaluru forecast is unavailable. Refresh or switch to a what-if amount.</p>}
      <button type="button" className="secondary-button" disabled={loadingWeather} onClick={() => setWeatherRetry((value) => value + 1)}>Refresh forecast</button>
    </div>}

    {mode === "hypothetical" && <div className="road-state-data">
      <label htmlFor="road-state-rain">Rainfall total (mm)</label>
      <input id="road-state-rain" type="number" min="0" max="500" step="1" value={hypotheticalMm}
        onChange={(event) => setHypotheticalMm(event.target.value)} />
      <span>Set a hypothetical city-wide rainfall total from 0 to 500 mm.</span>
    </div>}

    {mode === "history" && <div className="road-state-history">
      <p>Historical event records are available at district scale and have no road locations or flood footprints. The 2020 storm study below includes a measured gauge total that can be used as a clearly labeled what-if input.</p>
      <section className="road-state-historical-case" aria-labelledby="road-state-storm-title">
        <h4 id="road-state-storm-title">20–21 October 2020 Bengaluru storm</h4>
        <p><strong>{bengaluruStorm2020.highestGaugeRainfall24hMm} mm</strong> highest reported 24-hour gauge total at {bengaluruStorm2020.rainfallStation}.</p>
        <button type="button" className="secondary-button" disabled={loadingScreen}
          onClick={() => void runScreening(bengaluruStorm2020.highestGaugeRainfall24hMm)}>
          Screen historical gauge total · {bengaluruStorm2020.highestGaugeRainfall24hMm} mm
        </button>
        <p>Applying one station's total across the terrain grid is a what-if screen, not a city-wide rainfall reconstruction or observed road-flood replay.</p>
        <a href={bengaluruStorm2020.source.article} target="_blank" rel="noreferrer">Open storm study by {bengaluruStorm2020.source.authors}</a>
      </section>
      <HistoricalFloodTimeline />
    </div>}

    {mode !== "history" && <button type="button" className="primary-button road-state-run"
      disabled={loadingWeather || loadingScreen || rainfallMm === null || rainfallMm < 0 || rainfallMm > 500}
      onClick={() => void runScreening()}>
      {loadingScreen ? "Screening roads…" : "Run road screening"}
    </button>}

    {error && <p className="road-state-error" role="alert">{error}</p>}
    {result?.status === "ready" && <p className="road-state-result" role="status">
      <strong>Screening complete</strong> · {resultLabel ?? rainfallLabel}: {result.rainfall_mm.toFixed(1)} mm. The map marks mapped roads crossing screened terrain cells.
    </p>}
    <div className="road-state-key" aria-label="Road screening legend">
      <strong>Map key</strong>
      <span><i className="road-state-marker" /> Potential hotspot</span>
      <span><i className="road-state-gradient" /> Low to high runoff screen</span>
    </div>
    <p className="coverage-note">Coverage: Bengaluru study area. Basemap road coverage depends on map tiles. The model is a rainfall and terrain screening proxy; it does not confirm water depth, passability, closures, or calibrated probabilities. Follow official alerts.</p>
  </section>;
}
