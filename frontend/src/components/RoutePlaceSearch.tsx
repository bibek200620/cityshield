import { useEffect, useId, useRef, useState } from "react";
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
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const resultId = `${inputId}-results`;
  const label = endpoint === "source" ? "source" : "destination";

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) {
      request.current?.abort();
      setResults([]);
      setStatus(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    request.current = controller;
    setResults([]);
    setStatus(null);
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api.searchPlaces(value, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setResults(response.results);
          if (!response.results.length) setStatus("No matching place found in India.");
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setStatus(error instanceof Error ? error.message : "Place search is unavailable.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 450);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  function choose(place: PlaceSearchResult) {
    onSelect(place);
    setResults([]);
    setQuery("");
    input.current?.focus();
  }

  return (
    <div className="route-place-search" onKeyDown={(event) => {
      if (event.key !== "Escape" || !query) return;
      event.preventDefault();
      setQuery("");
      input.current?.focus();
    }}>
      <div className="route-search-row">
        <label className="sr-only" htmlFor={inputId}>Search {label} by place name</label>
        <input ref={input} id={inputId} type="search" value={query}
          placeholder="College, hotel, building or address" autoComplete="off" minLength={2} maxLength={120}
          aria-controls={results.length > 0 ? resultId : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results.length === 1) choose(results[0]);
          }} />
      </div>
      {loading && <p role="status" className="route-detail">Searching places…</p>}
      {status && <p role="status" className={status.startsWith("No matching") ? "route-detail" : "route-error"}>{status}</p>}
      {results.length > 0 && <ul id={resultId} className="route-place-results" aria-label={`Matching ${label} locations`}>
        {results.map((place) => (
          <li key={place.id}>
            <button type="button" onClick={() => choose(place)}>
              <span>{place.name}</span><small>{place.category}</small>
            </button>
          </li>
        ))}
      </ul>}
    </div>
  );
}
