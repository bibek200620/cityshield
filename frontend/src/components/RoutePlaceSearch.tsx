import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type PlaceSearchResult } from "../api/client";

export default function RoutePlaceSearch({
  endpoint,
  onSelect,
}: {
  endpoint: "source" | "destination";
  onSelect: (place: PlaceSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceSearchResult[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const label = endpoint === "source" ? "source" : "destination";

  useEffect(() => () => request.current?.abort(), []);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = query.trim();
    if (value.length < 2 || loading) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setStatus(null);
    setResults([]);
    try {
      const response = await api.searchPlaces(value, controller.signal);
      if (controller.signal.aborted) return;
      setResults(response.results);
      if (!response.results.length) setStatus("No matching place found inside Greater Bengaluru.");
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus(error instanceof Error ? error.message : "Place search is unavailable.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <div className="route-place-search">
      <form onSubmit={(event) => void search(event)}>
        <label className="sr-only" htmlFor={`route-${endpoint}-search`}>Search {label} by place name</label>
        <input id={`route-${endpoint}-search`} type="search" value={query}
          placeholder="College, hotel, building or address" autoComplete="off" minLength={2} maxLength={120}
          onChange={(event) => {
            setQuery(event.target.value);
            setStatus(null);
            setResults([]);
          }} />
        <button className="pick-button" type="submit" disabled={loading || query.trim().length < 2}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      {status && <p role="status" className={status.startsWith("No matching") ? "route-detail" : "route-error"}>{status}</p>}
      {results.length > 0 && <ul className="route-place-results" aria-label={`Matching ${label} locations`}>
        {results.map((place) => (
          <li key={place.id}>
            <button type="button" onClick={() => {
              onSelect(place);
              setResults([]);
              setQuery("");
            }}>
              <span>{place.name}</span><small>{place.category}</small>
            </button>
          </li>
        ))}
      </ul>}
      <p className="route-credit">Submitted place names are searched in OpenStreetMap. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>.</p>
    </div>
  );
}
