import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { WeatherAvailabilityResponse } from "../src/api/client";

const presets = [
  { scenario_id: "light", label: "Light shower", rainfall_intensity_mm_hr: 20, duration_min: 45 },
  { scenario_id: "moderate", label: "Moderate storm", rainfall_intensity_mm_hr: 60, duration_min: 90 },
];
const checkedAt = "2026-11-27T12:00:00Z";
const weather: Extract<WeatherAvailabilityResponse, { status: "ready" }> = {
  status: "ready", source: "Open-Meteo", valid_at: checkedAt, recent_through: checkedAt, forecast_through: checkedAt,
  air_temperature_c: 28, feels_like_c: 29, recent_rain_mm: 0, upcoming_rain_mm: 0, hourly_forecast: [],
  provenance: {
    provider: "Open-Meteo", api_version: "v1", endpoint: "/v1/forecast", model_selection: "Best Match",
    model_identifier: null, model_version: null, model_note: "Test fixture", cell_selection: "land",
    requested_location: { latitude: 12.98, longitude: 77.59 },
    grid_cell_center: { latitude: 12.98, longitude: 77.59, elevation_m: 900 },
    spatial_resolution_m: null, spatial_resolution_note: "Not reported", timezone: "UTC", utc_offset_seconds: 0,
    timestamps_are_unix_utc: true, units: { air_temperature: "°C", apparent_temperature: "°C", relative_humidity: "%", precipitation: "mm" },
    retrieved_at: checkedAt,
  },
};

async function mockAtlas(page: Page) {
  let forecastReady = false;
  let scenarioLoads = 0;
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await page.route("http://localhost:8000/api/**", async (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case "/api/scenarios":
        scenarioLoads++;
        return route.fulfill({ json: presets });
      case "/api/scenarios/moderate":
        return route.fulfill({ json: {
          scenario_id: "moderate", node_predictions: [], road_segments: [], at_risk_infra_ids: [],
          is_synthetic_ward: true, generated_at_utc: checkedAt, model_caveat: "Test simulation",
          input_provenance: [], limitations: [], model_mode: "test", model_version: "test",
          provenance_class: "simulated", rainfall_source: "Test input",
        } });
      case "/api/critical-infrastructure":
        return route.fulfill({ json: [] });
      case "/api/heat":
        return route.fulfill({ json: { status: "unavailable", message: "Local scene missing" } });
      case "/api/exposure/moderate":
      case "/api/assistant/outlook":
        return route.fulfill({ json: { status: "unavailable" } });
      case "/api/flood/city": {
        const rainfall = Number(url.searchParams.get("rainfall_mm"));
        return route.fulfill({ json: {
          status: "ready", rainfall_mm: rainfall, grid_m: 300, source: "Test grid", model: "Test screening",
          cells: [
            { id: "2637:4770:0", rings: [[[77.682, 12.93], [77.683, 12.93], [77.683, 12.931], [77.682, 12.93]]], screen_mm: rainfall === 90 ? 28 : 4 },
            { id: "2637:4771:0", rings: [[[77.682, 12.932], [77.683, 12.932], [77.683, 12.933], [77.682, 12.932]]], screen_mm: 0 },
            { id: "2632:4769:0", rings: [[[77.68, 12.93], [77.681, 12.93], [77.681, 12.931], [77.68, 12.93]]], screen_mm: null },
          ],
        } });
      }
      case "/api/weather/nowcast":
        return route.fulfill({ json: forecastReady ? weather : {
          status: "unavailable", reason: "stale_data", checked_at: checkedAt,
          message: "The latest weather estimate is stale.",
        } });
      default:
        return route.fulfill({ json: { status: "unavailable" } });
    }
  });
  return { scenarioLoads: () => scenarioLoads, restoreWeather: () => { forecastReady = true; } };
}

async function selectBellanduru(page: Page) {
  await page.getByRole("searchbox", { name: "Search India" }).fill("Bellandur");
  await page.getByRole("button", { name: "Bellanduru East" }).click();
}

test("ward comparison weights available cells, exports the evidence, and saves the baseline", async ({ page }) => {
  await mockAtlas(page);
  await page.goto("/");
  await selectBellanduru(page);
  const ward = page.getByRole("region", { name: "Ward analysis" });
  await expect(ward.getByText("Bellanduru", { exact: true })).toBeVisible();
  await expect(ward.getByText("14.0 mm", { exact: true })).toBeVisible();
  await expect(ward.getByText("50.0%", { exact: true })).toBeVisible();

  await ward.getByRole("button", { name: "Compare this ward" }).click();
  const compare = page.getByRole("complementary", { name: "Scenario comparison" });
  await compare.getByLabel("Baseline input").selectOption("light");
  await compare.getByRole("button", { name: "Save baseline" }).click();
  const change = compare.getByRole("row", { name: /Scored area above 20 mm/ });
  await expect(change.getByRole("cell", { name: "+50.0 pp" })).toBeVisible();

  const capture = page.waitForEvent("download");
  await compare.getByRole("button", { name: "Export comparison CSV" }).click();
  const download = await capture;
  expect(download.suggestedFilename()).toBe("cityshield-scenarios-3-47.csv");
  const csv = await readFile((await download.path())!, "utf-8");
  expect(csv).toContain('"Bellanduru, East","3:47","Light shower","Moderate storm"');
  expect(csv).toContain('"Scored area above 20 mm","%",0,50,50,"pp"');

  await page.reload();
  await page.getByRole("button", { name: "Compare scenarios", exact: true }).click();
  await expect(compare.getByText("Light shower", { exact: true }).last()).toBeVisible();
  const gridComparison = compare.getByRole("row", { name: /Grid cells above 20 mm/ });
  await expect(gridComparison.getByRole("cell", { name: "—" })).toHaveCount(2);
  await compare.getByRole("button", { name: "Clear baseline" }).click();
  await expect(compare.getByRole("button", { name: "Save baseline" })).toBeVisible();
});

test("source status distinguishes stale, historical, and missing data and can refresh", async ({ page }) => {
  const requests = await mockAtlas(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Data sources", exact: true }).click();
  const sources = page.getByRole("region", { name: "Source status" });
  const source = (name: string) => sources.getByRole("listitem").filter({ hasText: name });
  await expect(source("Weather forecast")).toContainText("Stale");
  await expect(source("Surface-temperature imagery")).toContainText("Historical");
  await expect(source("Municipal runoff")).toContainText("90.0 mm input");
  await expect(source("Local heat-model inputs")).toContainText("Unavailable");
  const loadsBeforeRefresh = requests.scenarioLoads();
  requests.restoreWeather();
  await sources.getByRole("button", { name: "Refresh sources" }).click();
  await expect(source("Weather forecast")).toContainText("Ready");
  await expect(source("Weather forecast")).toContainText("IST");
  await expect(source("Municipal runoff")).toContainText("90.0 mm input");
  expect(requests.scenarioLoads()).toBe(loadsBeforeRefresh);
});
