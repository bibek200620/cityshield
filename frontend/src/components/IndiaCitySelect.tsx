import { useEffect, useMemo, useState } from "react";
import { loadIndiaCities, type IndiaCity } from "../map/indiaCities";
import { supportsBengaluruSimulation, type MapPlace } from "../map/places";

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
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadIndiaCities(controller.signal).then((catalog) => setCities(catalog.places)).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "India city list could not be loaded.");
    });
    return () => controller.abort();
  }, []);

  const grouped = useMemo(() => {
    const groups = new Map<string, IndiaCity[]>();
    for (const city of cities) {
      const group = groups.get(city.state);
      if (group) group.push(city);
      else groups.set(city.state, [city]);
    }
    return [...groups].sort(([left], [right]) => left.localeCompare(right, "en-IN"));
  }, [cities]);
  const selectedName = selectedPlace?.name.split(",")[0].trim().toLocaleLowerCase();
  const placeCity = selectedName ? cities.find((item) => item.name.toLocaleLowerCase() === selectedName)
    ?? cities.find((item) => selectedName.includes(item.name.toLocaleLowerCase()) && item.name.length > 3) : null;
  const effectiveId = selectedPlace ? placeCity?.id ?? "" : selectedId;
  const selectedCity = cities.find((city) => city.id === effectiveId);
  const supportsCurrentModel = supportsBengaluruSimulation(selectedPlace);

  return (
    <div className="simulation-location">
      <label htmlFor="simulation-city">Simulation area</label>
      <select id="simulation-city" value={effectiveId} disabled={!cities.length || Boolean(error)}
        aria-describedby="simulation-city-help simulation-city-status"
        onChange={(event) => {
          const city = cities.find((item) => item.id === event.target.value);
          setSelectedId(city?.id ?? "");
          if (city) onSelect(placeForCity(city));
        }}>
        {!effectiveId && <option value="">Choose a city</option>}
        {grouped.map(([state, entries]) => <optgroup label={state} key={state}>
          {entries.map((city) => <option value={city.id} key={city.id}>{city.name} · {city.population.toLocaleString("en-IN")}</option>)}
        </optgroup>)}
      </select>
      <p id="simulation-city-help" className="scenario-result">
        Type a city name in the open list or scroll by state. City list:
        {" "}<a href="https://www.geonames.org/">GeoNames</a> (CC BY 4.0).
      </p>
      <p id="simulation-city-status" className="scenario-result" role={error ? "alert" : "status"}>
        {error ?? (cities.length === 0 ? "Loading Indian cities…" : supportsCurrentModel
          ? `The available flood simulation is the Bellandur study area in Bengaluru${selectedCity ? ` (${selectedCity.name})` : ""}.`
          : "A local flood simulation is not available for this city. The Bengaluru study area will not be shown for another location.")}
      </p>
    </div>
  );
}
