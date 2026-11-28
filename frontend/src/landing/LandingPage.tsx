import { useEffect, useRef, useState } from "react";
import Icon from "../components/Icon";
import storm from "../data/bengaluru-storm-2020.json";
import type { createGlobe } from "./globeScene";
import "./landing.css";

const sources = "https://github.com/bibek200620/cityshield/blob/main/docs/DATA_SOURCES.md";
const motionPreference = "(prefers-reduced-motion: reduce)";

function useGlobe() {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<typeof createGlobe>>();
  const [reduced, setReduced] = useState(() => matchMedia(motionPreference).matches);
  const [available, setAvailable] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const preference = matchMedia(motionPreference);
    const update = () => setReduced(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element || reduced) return;
    let active = true;
    void import("./globeScene").then(({ createGlobe }) => {
      if (!active) return;
      scene.current = createGlobe(element, () => setAvailable(true), () => {
        setAvailable(false);
        setUnavailable(true);
        // Dispose outside the WebGL event/load callback.
        queueMicrotask(() => {
          if (active) {
            scene.current?.dispose();
            scene.current = undefined;
          }
        });
      });
    }).catch(() => {
      if (active) setUnavailable(true);
    });
    return () => {
      active = false;
      scene.current?.dispose();
      scene.current = undefined;
      setAvailable(false);
      setUnavailable(false);
      setPaused(false);
    };
  }, [reduced]);

  function toggleMotion() {
    scene.current?.setPaused(!paused);
    setPaused(!paused);
  }

  return { host, available, fallback: reduced || unavailable, paused, toggleMotion };
}

function AtlasLink({ quiet = false }: { quiet?: boolean }) {
  return (
    <a className={quiet ? "landing-button landing-button-quiet" : "landing-button"} href="/">
      Open the atlas <Icon name="chevron" />
    </a>
  );
}

export default function LandingPage() {
  const { host, available, fallback, paused, toggleMotion } = useGlobe();

  useEffect(() => {
    const title = document.title;
    document.title = "CityShield · Weather, routes and urban flood research";
    return () => { document.title = title; };
  }, []);

  return (
    <div className="landing">
      <div ref={host} className={`landing-globe${available ? " landing-globe-ready" : ""}${fallback ? " landing-globe-fallback" : ""}`} aria-hidden="true" />
      <a className="skip-link" href="#landing-main">Skip to content</a>
      <div className="landing-foreground">
        <header className="landing-header landing-wrap">
          <a className="landing-brand" href="/welcome">
            <img src="/cityshield.svg" alt="" width="30" height="30" /> CityShield
          </a>
          <nav aria-label="Explore CityShield">
            <a href="#weather">Weather</a>
            <a href="#routes">Routes</a>
            <a href="#research">Research</a>
          </nav>
          <AtlasLink quiet />
        </header>

        <main id="landing-main" tabIndex={-1}>
          <section className="landing-hero landing-wrap" aria-labelledby="landing-title">
            <div className="landing-intro">
              <h1 id="landing-title">Read the weather.<br />Plan the road ahead.</h1>
              <p>Explore rain, heat and driving routes across India. Look closer in Bengaluru with ward-level runoff scenarios and satellite surface temperatures.</p>
              <div className="landing-intro-actions">
                <AtlasLink />
                <a className="landing-text-link" href="#research">Explore the research</a>
              </div>
            </div>
            <div className="landing-hero-foot">
              <a className="landing-scroll" href="#weather">See the weather layers <Icon name="chevron" /></a>
              {available && (
                <button type="button" className="landing-motion" onClick={toggleMotion}>
                  {paused ? "Resume globe motion" : "Pause globe motion"}
                </button>
              )}
            </div>
          </section>

          <section id="weather" className="landing-section landing-section-end landing-wrap" aria-labelledby="weather-heading">
            <div className="landing-panel">
              <div className="landing-panel-icon"><Icon name="rain" /></div>
              <h2 id="weather-heading">From a place forecast to a countrywide view.</h2>
              <p>Search for a city, town or landmark in India. Check the next three hours or open a two-day report and export the hourly estimates.</p>
              <dl className="landing-facts">
                <div><dt>Rainfall</dt><dd>24-hour forecast totals</dd></div>
                <div><dt>Air temperature</dt><dd>Forecast at 2 m above ground</dd></div>
                <div><dt>Surface temperature</dt><dd>Daytime satellite imagery</dd></div>
              </dl>
            </div>
          </section>

          <section id="routes" className="landing-section landing-wrap" aria-labelledby="routes-heading">
            <div className="landing-panel">
              <div className="landing-panel-icon"><Icon name="route" /></div>
              <h2 id="routes-heading">See what’s along your route.</h2>
              <p>Compare driving alternatives by ETA, distance and available rain or flood information. Start navigation with your device’s GPS.</p>
              <dl className="landing-facts">
                <div><dt>Traffic-aware ETA</dt><dd>Where provider coverage is available</dd></div>
                <div><dt>Flood exposure</dt><dd>Incident reports and modeled runoff where available</dd></div>
              </dl>
            </div>
          </section>

          <section id="research" className="landing-section landing-section-end landing-wrap" aria-labelledby="research-heading">
            <div className="landing-panel">
              <div className="landing-panel-icon"><Icon name="flood" /></div>
              <h2 id="research-heading">What happens when Bengaluru gets more rain?</h2>
              <p>Set rainfall intensity and duration, compare estimated runoff across wards, and inspect the Bellandur pilot’s simulated depths and road exposure.</p>
              <figure className="landing-observation">
                <strong>{storm.highestGaugeRainfall24hMm} <small>mm</small></strong>
                <figcaption>
                  <span>Observed rainfall over 24 hours</span>
                  <span>Kengeri · October 2020</span>
                  <a href={storm.source.article}>Read the published storm study</a>
                </figcaption>
              </figure>
              <p className="landing-panel-note">The atlas includes a replay of published drain readings and a ward-level view of Landsat surface temperatures.</p>
            </div>
          </section>

          <section className="landing-end" aria-labelledby="landing-end-heading">
            <div className="landing-wrap">
              <h2 id="landing-end-heading">Explore your area.</h2>
              <AtlasLink />
              <p>CityShield is a research prototype. Follow official local advisories for travel, flood, heat and emergency decisions.</p>
            </div>
          </section>
        </main>

        <footer className="landing-footer landing-wrap">
          <a className="landing-brand" href="/welcome">
            <img src="/cityshield.svg" alt="" width="26" height="26" /> CityShield
          </a>
          <a className="landing-text-link" href={sources}>Data sources and methods</a>
        </footer>
      </div>
    </div>
  );
}
