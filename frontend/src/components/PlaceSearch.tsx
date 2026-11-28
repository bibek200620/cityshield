import { useEffect, useId, useRef, useState } from "react";
import { api, type PlaceSearchResult } from "../api/client";
import type { MapPlace } from "../map/places";
import Icon from "./Icon";

function fromSearchResult(place: PlaceSearchResult): MapPlace {
  const delta = 0.08;
  return { id: place.id, name: place.name, center: [place.lng, place.lat],
    bounds: [place.lng - delta, place.lat - delta, place.lng + delta, place.lat + delta] };
}

const aliases: Record<string, string> = {
  bellandur: "bellanduru",
  koramangala: "kormangala",
  "white field": "whitefield",
};

interface PlaceSearchProps {
  selected: MapPlace | null;
  onSelect: (place: MapPlace) => void;
  label?: string;
  placeholder?: string;
}

export default function PlaceSearch({
  selected, onSelect, label = "Search India", placeholder = "City, town or landmark in India",
}: PlaceSearchProps) {
  const inputId = useId();
  const resultsId = useId();
  const input = useRef<HTMLInputElement>(null);
  const resultsList = useRef<HTMLUListElement>(null);
  const [places, setPlaces] = useState<MapPlace[]>([]);
  const [indiaPlaces, setIndiaPlaces] = useState<MapPlace[]>([]);
  const [completedQuery, setCompletedQuery] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" ||
        document.querySelector("dialog[open]")) return;
      event.preventDefault();
      input.current?.focus();
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/bengaluru-wards.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Ward index unavailable");
        return response.json() as Promise<MapPlace[]>;
      })
      .then(setPlaces)
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const value = query.trim();
    if (value.length < 3) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.searchPlaces(value, controller.signal).then((response) => {
        if (!controller.signal.aborted) setIndiaPlaces(response.results.map(fromSearchResult));
      }).catch(() => {
        if (!controller.signal.aborted) setIndiaPlaces([]);
      }).finally(() => {
        if (!controller.signal.aborted) setCompletedQuery(value);
      });
    }, 700);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const term = query.trim().toLocaleLowerCase();
  const match = aliases[term] ?? term;
  const wardResults = term.length >= 2 ? places.filter((place) =>
    place.name.toLocaleLowerCase().includes(match) || Boolean(place.kannada?.includes(term)),
  ).slice(0, 7) : [];
  const remoteReady = completedQuery === query.trim();
  const results = [...wardResults, ...(remoteReady ? indiaPlaces : [])].slice(0, 7);

  return (
    <div className="place-search" role="search" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setQuery("");
    }}>
      <label className="sr-only" htmlFor={inputId}>{label}</label>
      <span className="search-glyph"><Icon name="search" /></span>
      <input ref={input} id={inputId} type="search" placeholder={selected?.name ?? placeholder} value={query}
        aria-keyshortcuts="Control+K Meta+K"
        aria-controls={error || match.length >= 2 ? resultsId : undefined}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && results.length) {
            event.preventDefault();
            resultsList.current?.querySelector("button")?.focus();
          }
          if (event.key === "Enter" && results.length === 1) {
            onSelect(results[0]);
            setQuery("");
          }
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            setQuery("");
          }
        }}
        autoComplete="off" />
      {!query && <kbd className="search-shortcut" aria-hidden="true" title="Control or Command + K">Ctrl K</kbd>}
      {(error || match.length >= 2) && (
        <div className="search-results" id={resultsId}>
          {results.length > 0 ? <ul ref={resultsList} aria-label="Matching areas">
            {results.map((place) => <li key={place.id}>
              <button type="button" onClick={(event) => {
                onSelect(place);
                setQuery("");
                if (event.detail === 0) input.current?.focus();
              }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setQuery("");
                    input.current?.focus();
                  }
                  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    const row = event.currentTarget.parentElement;
                    const next = event.key === "ArrowUp" ? row?.previousElementSibling : row?.nextElementSibling;
                    if (next) next.querySelector("button")?.focus();
                    else if (event.key === "ArrowUp") input.current?.focus();
                  }
                }}>
                {place.name} {place.corporation && <small>{place.corporation}</small>}
              </button>
            </li>)}
          </ul> : <p role="status">{error ? "Ward search unavailable." :
            query.trim().length < 3 ? "Enter three characters to search India." :
              !remoteReady ? "Searching India…" : "No matching place found. Try a nearby area name."}</p>}
        </div>
      )}
    </div>
  );
}
