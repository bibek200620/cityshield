export interface IndiaCity {
  id: string;
  name: string;
  state: string;
  lat: number;
  lng: number;
  population: number;
}

interface IndiaCityCatalog {
  source: string;
  license: string;
  attribution: string;
  coverage: string;
  places: IndiaCity[];
}

let cachedCatalog: IndiaCityCatalog | null = null;

export async function loadIndiaCities(signal?: AbortSignal): Promise<IndiaCityCatalog> {
  if (cachedCatalog) return cachedCatalog;
  const response = await fetch("/data/india-cities.json", { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("India city list could not be loaded.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !Array.isArray((value as IndiaCityCatalog).places)) {
    throw new Error("India city list has an invalid format.");
  }
  const catalog = value as IndiaCityCatalog;
  if (!catalog.places.length || catalog.places.some((city) => !city.id || !city.name || !city.state
    || !Number.isFinite(city.lat) || !Number.isFinite(city.lng))) {
    throw new Error("India city list contains invalid locations.");
  }
  cachedCatalog = catalog;
  return catalog;
}
