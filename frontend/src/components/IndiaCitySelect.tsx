import { useEffect, useMemo, useState } from "react";
import { loadIndiaCities, type IndiaCity } from "../map/indiaCities";
import { supportsBengaluruSimulation, type MapPlace } from "../map/places";

const normalize = (value: string) => value.trim().toLocaleLowerCase("en-IN");

function placeForCity(city: IndiaCity): MapPlace {
  const delta = 0.08;
  return {
    id: `geonames:${city.id}`,
    name: `${city.name}, ${city.state}`,
    center: [city.lng, city.lat],
    bounds: [city.lng - delta, city.lat - delta, city.lng + delta, city.lat + delta],
  };
}

export default function IndiaCitySelect({ selectedPlace, onSelect }: {
  selectedPlace: MapPlace | null;
  onSelect: (place: MapPlace) => void;
}) {
  const [cities, setCities] = useState<IndiaCity[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadIndiaCities(controller.signal).then((catalog) => setCities(catalog.places)).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "India city list could not be loaded.");
    });
    return () => controller.abort();
  }, []);

  const search = normalize(query).replace(/\bbangalore\b/g, "bengaluru");
  const matches = useMemo(() => {
    if (!search) return cities;
    const terms = search.split(/[\s,]+/).filter(Boolean);
    return cities.filter((city) => terms.every((term) => normalize(`${city.name} ${city.state}`).includes(term)));
  }, [cities, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, IndiaCity[]>();
    for (const city of matches) {
      const group = groups.get(city.state);
      if (group) group.push(city);
      else groups.set(city.state, [city]);
    }
    return [...groups].sort(([left], [right]) => left.localeCompare(right, "en-IN"));
  }, [matches]);
  const selectedName = normalize(selectedPlace?.name.split(",")[0] ?? "");
  const selectedCity = cities.find((city) => selectedPlace?.id === `geonames:${city.id}`)
    ?? cities.find((city) => normalize(city.name) === selectedName)
    ?? cities.find((city) => city.name.length > 3 && selectedName.includes(normalize(city.name)));
  const selectedOutsideSearch = selectedCity && !matches.includes(selectedCity);
  const supportsCurrentModel = supportsBengaluruSimulation(selectedPlace);

  function chooseCity(city: IndiaCity) {
    setQuery("");
    onSelect(placeForCity(city));
  }

  return (
    <div className="simulation-location">
      <label htmlFor="simulation-city-search">Search cities</label>
      <input id="simulation-city-search" type="search" placeholder="City or state" value={query} autoComplete="off"
        disabled={!cities.length || Boolean(error)} aria-controls="simulation-city" aria-describedby="simulation-city-help"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !search) return;
          event.preventDefault();
          const exact = matches.filter((city) => normalize(city.name) === search);
          if (matches.length === 1) chooseCity(matches[0]);
          else if (exact.length === 1) chooseCity(exact[0]);
          else if (matches.length) document.getElementById("simulation-city")?.focus();
        }} />
      <label htmlFor="simulation-city">Simulation area</label>
      <select id="simulation-city" value={selectedCity?.id ?? ""} disabled={!matches.length || Boolean(error)}
        aria-describedby="simulation-city-help simulation-city-status"
        onChange={(event) => {
          const city = matches.find((item) => item.id === event.target.value);
          if (city) chooseCity(city);
        }}>
        {!selectedCity && <option value="" disabled>Choose a city</option>}
        {selectedOutsideSearch && <option value={selectedCity.id} disabled>{selectedCity.name} · {selectedCity.state} (selected)</option>}
        {grouped.map(([state, entries]) => <optgroup label={state} key={state}>
          {entries.map((city) => <option value={city.id} key={city.id}>{city.name} · {city.population.toLocaleString("en-IN")}</option>)}
        </optgroup>)}
      </select>
      {search && <p className="scenario-result" role="status">{matches.length
        ? `${matches.length} matching ${matches.length === 1 ? "city" : "cities"}`
        : "No cities match your search."}</p>}
      <p id="simulation-city-help" className="scenario-result">
        Search by city or state, or browse the list. Press Enter to select a single match.
        {" "}City data from <a href="https://www.geonames.org/">GeoNames</a> (CC BY 4.0).
      </p>
      <p id="simulation-city-status" className="scenario-result" role={error ? "alert" : "status"}>
        {error ?? (cities.length === 0 ? "Loading Indian cities…" : supportsCurrentModel
          ? `The available flood simulation is the Bellandur study area in Bengaluru${selectedCity ? ` (${selectedCity.name})` : ""}.`
          : "A local flood simulation is not available for this city. The Bengaluru study area will not be shown for another location.")}
      </p>
    </div>
  );
}
