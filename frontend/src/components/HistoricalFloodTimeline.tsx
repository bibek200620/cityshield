import { useEffect, useMemo, useState } from "react";
import { api, type FloodHistoryResponse } from "../api/client";

function dateLabel(start: string, end: string) {
  return start === end ? start : `${start} to ${end}`;
}

export default function HistoricalFloodTimeline() {
  const [history, setHistory] = useState<FloodHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState("all");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void api.getFloodHistory(controller.signal)
      .then(setHistory)
      .catch(() => { if (!controller.signal.aborted) setError("Historical flood records could not load."); });
    return () => controller.abort();
  }, [retry]);

  const years = useMemo(() => [...new Set((history?.events ?? []).map((event) => event.start_date.slice(0, 4)))].sort(), [history]);
  const events = useMemo(() => (history?.events ?? []).filter((event) => year === "all" || event.start_date.startsWith(year)), [history, year]);

  return <section className="detail-content historical-flood-history" aria-labelledby="historical-flood-title">
    <h3 id="historical-flood-title">Historical flood event timeline</h3>
    <p>District-level event records for Bengaluru Urban. Dates cannot be replayed on the map because the records have no flood-footprint coordinates.</p>
    {error && <p role="alert">{error} <button className="text-button" type="button" onClick={() => {
      setHistory(null); setError(null); setRetry((value) => value + 1);
    }}>Retry</button></p>}
    {history?.status === "unavailable" && <p role="status">No historical event inventory is available in this local run.</p>}
    {history?.status === "ready" && <>
      <div className="history-controls">
        <label htmlFor="history-year">Filter by start year</label>
        <select id="history-year" value={year} onChange={(event) => setYear(event.target.value)}>
          <option value="all">All years</option>
          {years.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <span>{events.length} of {history.events.length} records</span>
      </div>
      <ol className="history-timeline">
        {events.map((event) => <li key={event.id}>
          <time dateTime={event.start_date}>{dateLabel(event.start_date, event.end_date)}</time>
          <strong>{event.reported_cause}</strong>
          <span>{event.districts_listed.length > 1
            ? `Bengaluru Urban was one of ${event.districts_listed.length} listed districts.`
            : "Recorded for Bengaluru Urban district."}</span>
          <small>{event.source_event_source} · {event.date_precision.replace(/_/g, " ")} · not evaluation eligible</small>
        </li>)}
      </ol>
      {history.limitations.map((limitation) => <p className="coverage-note" key={limitation}>{limitation}</p>)}
      <p className="coverage-note">{history.citation.dataset} · {history.citation.license} · <a href={`https://doi.org/${history.citation.doi}`} target="_blank" rel="noreferrer">Dataset citation</a></p>
    </>}
  </section>;
}
