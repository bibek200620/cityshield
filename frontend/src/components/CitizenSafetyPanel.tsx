import { FormEvent, useEffect, useRef, useState } from "react";
import { api, type NearbyFacilitiesResponse } from "../api/client";
import type { MapPlace } from "../map/places";

interface LocalFloodReport {
  id: string;
  placeName: string;
  latitude: number;
  longitude: number;
  kind: "waterlogging" | "road-obstruction";
  description: string;
  createdAt: string;
  status: "unverified";
}

const STORAGE_KEY = "cityshield.local-flood-reports.v1";
const REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPORT_LIMIT = 100;

function readReports(): LocalFloodReport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - REPORT_TTL_MS;
    return parsed.filter((item): item is LocalFloodReport => Boolean(item)
      && typeof item.id === "string"
      && typeof item.placeName === "string"
      && Number.isFinite(item.latitude)
      && Number.isFinite(item.longitude)
      && (item.kind === "waterlogging" || item.kind === "road-obstruction")
      && typeof item.description === "string"
      && typeof item.createdAt === "string"
      && Date.parse(item.createdAt) >= cutoff
      && item.status === "unverified").slice(0, REPORT_LIMIT);
  } catch {
    return [];
  }
}

export default function CitizenSafetyPanel({ place }: { place: MapPlace | null }) {
  const [reports, setReports] = useState<LocalFloodReport[]>([]);
  const [kind, setKind] = useState<LocalFloodReport["kind"]>("waterlogging");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyFacilitiesResponse | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const nearbyRequest = useRef<AbortController | null>(null);

  useEffect(() => setReports(readReports()), []);

  useEffect(() => {
    nearbyRequest.current?.abort();
    nearbyRequest.current = null;
    setNearby(null);
    setNearbyError(null);
    setNearbyLoading(false);
    return () => nearbyRequest.current?.abort();
  }, [place]);

  async function loadNearby() {
    if (!place) return;
    nearbyRequest.current?.abort();
    const controller = new AbortController();
    nearbyRequest.current = controller;
    setNearbyLoading(true);
    setNearbyError(null);
    try {
      setNearby(await api.getNearbyFacilities({ lat: place.center[1], lng: place.center[0] }, controller.signal));
    } catch {
      if (!controller.signal.aborted) setNearbyError("Nearby facility listings could not load.");
    } finally {
      if (!controller.signal.aborted) setNearbyLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!place || reports.length >= REPORT_LIMIT) return;
    const next: LocalFloodReport = {
      id: crypto.randomUUID(),
      placeName: place.name,
      latitude: place.center[1],
      longitude: place.center[0],
      kind,
      description: description.trim(),
      createdAt: new Date().toISOString(),
      status: "unverified",
    };
    const updated = [next, ...reports].slice(0, REPORT_LIMIT);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setReports(updated);
      setDescription("");
      setMessage("Saved in this browser. It has not been shared or verified.");
    } catch {
      setMessage("This browser could not save the report. Check local storage availability.");
    }
  }

  function clearReports() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      setReports([]);
      setMessage("Reports saved in this browser were removed.");
    } catch {
      setMessage("This browser could not remove the saved reports.");
    }
  }

  return <section className="detail-content citizen-safety" aria-labelledby="citizen-safety-title">
    <h3 id="citizen-safety-title">Citizen safety</h3>
    <p><strong>Emergency in India:</strong> call <a href="tel:112">112</a>. The national emergency response system handles police, fire, health, and other emergencies.</p>
    <p><a href="https://www.mha.gov.in/emergency-response-support-system-erss" target="_blank" rel="noreferrer">Emergency response information</a></p>

    <h4>Nearby mapped facilities</h4>
    <p>Nearby hospitals, fire stations, police services, and community centres may be listed for the selected location. Listings do not verify current operation, capacity, emergency access, or cooling-centre availability.</p>
    {!place && <p>Select a place to search nearby facilities.</p>}
    {place && <button className="secondary-button" type="button" disabled={nearbyLoading} onClick={() => void loadNearby()}>
      {nearbyLoading ? "Searching nearby…" : "Search nearby facilities"}
    </button>}
    {nearbyLoading && <p role="status">Loading nearby listings…</p>}
    {nearbyError && <p role="status">{nearbyError}</p>}
    {nearby?.status === "empty" && <p>No nearby facilities were returned for this area.</p>}
    {nearby?.results.length ? <ul className="nearby-facility-list">
      {nearby.results.map((facility) => <li key={facility.id}>
        <strong>{facility.name}</strong>
        <span>{(facility.category ?? "Facility listing").replace(/_/g, " ")} · Listing not verified</span>
        {facility.map_url && <a href={facility.map_url} target="_blank" rel="noreferrer">Open map listing</a>}
      </li>)}
    </ul> : null}
    {nearby?.limitations.map((limitation) => <p className="coverage-note" key={limitation}>{limitation}</p>)}

    <h4>Local waterlogging report</h4>
    <p>Reports are kept only in this browser, marked unverified, and removed after 30 days. They do not appear to other people or change route recommendations. Photo review and public report sharing are not connected.</p>
    <form className="citizen-report-form" onSubmit={submit}>
      <label>Report location
        <span>{place ? `${place.name} (${place.center[1].toFixed(4)}, ${place.center[0].toFixed(4)})` : "Search for and select a place in India first."}</span>
      </label>
      <label>Report type
        <select value={kind} onChange={(event) => setKind(event.target.value as LocalFloodReport["kind"])}>
          <option value="waterlogging">Waterlogging observed</option>
          <option value="road-obstruction">Road obstruction observed</option>
        </select>
      </label>
      <label>Details (optional)
        <textarea value={description} onChange={(event) => setDescription(event.target.value.slice(0, 400))}
          maxLength={400} rows={3} placeholder="Avoid names, phone numbers, or other personal details." />
      </label>
      <button className="secondary-button" type="submit" disabled={!place || reports.length >= REPORT_LIMIT}>Save unverified report</button>
    </form>
    {message && <p role="status">{message}</p>}
    {reports.length > 0 && <div className="citizen-report-list">
      <div><strong>Saved in this browser ({reports.length})</strong><button className="text-button" type="button" onClick={clearReports}>Clear</button></div>
      <ul>{reports.slice(0, 5).map((report) => <li key={report.id}>
        <strong>{report.kind === "waterlogging" ? "Waterlogging" : "Road obstruction"} · Unverified</strong>
        <span>{report.placeName} · {new Date(report.createdAt).toLocaleString()}</span>
        {report.description && <span>{report.description}</span>}
      </li>)}</ul>
      {reports.length > 5 && <p>Showing the 5 most recent reports.</p>}
    </div>}
  </section>;
}
