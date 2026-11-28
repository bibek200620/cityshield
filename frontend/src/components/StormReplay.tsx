import { useEffect, useState } from "react";
import replay from "../data/bengaluru-storm-2020.json";
import StormComparison from "./StormComparison";
import "./stormReplay.css";

const valleys: Record<string, string> = {
  KC: "Koramangala–Chellagatta Valley",
  HB: "Hebbal Valley",
  VV: "Vrishabhavathi Valley",
};

const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: replay.timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const timeLabel = (value: string) => dateTime.format(new Date(value));
const depth = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const lastIndex = replay.snapshots.length - 1;
const sensorsWithPeaks = replay.snapshots.filter((snapshot) => snapshot.studyPeak).length;

export default function StormReplay() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const snapshot = replay.snapshots[index];
  const peak = snapshot.studyPeak;
  const conflictingDepth = peak?.observedAt === snapshot.observedAt && peak.observedDepthM !== snapshot.observedDepthM;
  const alternateTime = Boolean(peak && peak.observedAt !== snapshot.observedAt);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      setIndex(index + 1);
      if (index + 1 === lastIndex) setPlaying(false);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [index, playing]);

  function goTo(step: number) {
    setPlaying(false);
    setIndex(step);
  }

  return <section className="storm-replay" aria-label="October 2020 Bengaluru storm">
    <header className="storm-intro">
      <div>
        <h3>20–21 October 2020</h3>
        <p>Step through five published drain readings in IST. The study publishes model peaks for {sensorsWithPeaks} of these sensors.</p>
      </div>
      <dl className="storm-rainfall">
        <dt>Highest 24-hour gauge total</dt>
        <dd>{replay.highestGaugeRainfall24hMm} <small>mm</small></dd>
        <dd>{replay.rainfallStation} · event context</dd>
      </dl>
    </header>

    <div className="storm-controls">
      <div>
        <button type="button" className="secondary-button" onClick={() => goTo(index - 1)} disabled={index === 0}>Previous</button>
        <button type="button" className="primary-button" onClick={() => {
          if (!playing && index === lastIndex) setIndex(0);
          setPlaying(!playing);
        }}>{playing ? "Pause replay" : "Play replay"}</button>
        <button type="button" className="secondary-button" onClick={() => goTo(index + 1)} disabled={index === lastIndex}>Next</button>
      </div>
      <p>Snapshot {index + 1} of {replay.snapshots.length} · IST</p>
    </div>

    <ol className="storm-timeline" aria-label="Published sensor snapshots">
      {replay.snapshots.map((item, step) => <li key={item.sensorId}>
        <button type="button" aria-pressed={step === index} onClick={() => goTo(step)}>
          <time dateTime={item.observedAt}>{timeLabel(item.observedAt)}</time>
          <span>{item.location}</span>
        </button>
      </li>)}
    </ol>

    <p className="sr-only" role="status">{snapshot.location}, {timeLabel(snapshot.observedAt)} IST. Observed drain water depth {depth.format(snapshot.observedDepthM)} metres.</p>
    <div className="storm-sensor">
      <h4>{snapshot.location}</h4>
      <p>{valleys[snapshot.valley]} · Sensor {snapshot.sensorId}</p>
    </div>

    <div className="storm-pair">
      <section aria-labelledby="storm-observed-title">
        <h5 id="storm-observed-title">Published sensor reading</h5>
        <p className="storm-depth">{depth.format(snapshot.observedDepthM)} <small>m</small></p>
        <p><time dateTime={snapshot.observedAt}>{timeLabel(snapshot.observedAt)} IST</time> · Table S3</p>
        <p className="storm-drain-depth">Drain depth {depth.format(snapshot.drainDepthM)} m</p>
      </section>
      <section aria-labelledby="storm-model-title">
        <h5 id="storm-model-title">Published model peak</h5>
        {peak ? <>
          <p className="storm-depth">{depth.format(peak.modelDepthM)} <small>m</small></p>
          <p><time dateTime={peak.modelAt}>{timeLabel(peak.modelAt)} IST</time> · Table S6</p>
          <p className="storm-drain-depth">{replay.source.model} · {replay.source.authors}</p>
        </> : <p className="storm-no-peak">Table S6 gives no model peak for this sensor.</p>}
      </section>
    </div>

    {peak && <p className={`storm-reconciliation${conflictingDepth ? " storm-reconciliation-conflict" : ""}`}>
      {conflictingDepth ? <>The tables disagree at this timestamp. Table S6 reports {depth.format(peak.observedDepthM)} m,
        while Table S3 reports {depth.format(snapshot.observedDepthM)} m. The discrepancy remains unresolved.</> :
        alternateTime ? <>Table S6 reports an observed peak of {depth.format(peak.observedDepthM)} m at {timeLabel(peak.observedAt)} IST,
          a different time from the Table S3 reading. The model value is its own event peak.</> :
          <>Table S6 reports an observed peak of {depth.format(peak.observedDepthM)} m at {timeLabel(peak.observedAt)} IST.
            The model value is its own event peak.</>}
    </p>}

    <p className="storm-sources">
      <a href={replay.source.article}>Study by {replay.source.authors}</a>
      <a href={replay.source.supplement}>Supplementary Tables S3, S5 and S6</a>
      <a href={replay.source.license}>CC BY 4.0</a>
    </p>
    <StormComparison />
  </section>;
}
