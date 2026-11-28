import { expect, test } from "@playwright/test";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { createRoadRunoffScreen, roadRunoffBand } from "../src/map/roadRunoff";

test("road screening clips to the flagged cell and excludes grade-separated crossings", () => {
  const screen = createRoadRunoffScreen([{
    rings: [[[77.59, 12.97], [77.60, 12.97], [77.60, 12.98], [77.59, 12.98], [77.59, 12.97]]],
    screen_mm: 20,
  }]);
  const road = (lat: number, properties: MapGeoJSONFeature["properties"]) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[77.58, lat], [77.61, lat]] },
    properties,
  }) as MapGeoJSONFeature;

  const segments = screen([
    road(12.973, { name: "Outer Ring Road", is_bridge: "false" }),
    road(12.975, { name: "Flyover", is_bridge: true }),
    road(12.977, { name: "Tunnel", is_tunnel: "yes" }),
  ]);
  expect(segments).toHaveLength(1);
  expect(segments[0].name).toBe("Outer Ring Road");
  expect(segments[0].path[0][0]).toBeCloseTo(77.59);
  expect(segments[0].path[1][0]).toBeCloseTo(77.60);
  expect(roadRunoffBand(5).label).toBe("Lower");
  expect(roadRunoffBand(segments[0].runoffMm).label).toBe("Moderate");
  expect(roadRunoffBand(20.01).label).toBe("Higher");
});

test("road flood risk opens the Bengaluru forecast without running a scenario", async ({ page }) => {
  let forecastRequests = 0;
  await page.route("https://basemaps.cartocdn.com/**", (route) =>
    route.fulfill({ json: { version: 8, layers: [], sources: {} } }));
  await page.route("http://localhost:8000/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { "access-control-allow-origin": "*" };
    if (path === "/api/scenarios" || path === "/api/critical-infrastructure") {
      return route.fulfill({ json: [], headers });
    }
    if (path === "/api/weather/road-runoff") {
      forecastRequests++;
      return route.fulfill({ json: {
        status: "ready", grid_m: 300, forecast_points: 5, forecast_through: new Date().toISOString(), cells: [],
      }, headers });
    }
    return route.fulfill({ json: { status: "unavailable" }, headers });
  });
  await page.goto("/");
  const risk = page.getByRole("checkbox", { name: "Road flood risk", exact: true });
  await expect(risk).not.toBeChecked();
  expect(forecastRequests).toBe(0);
  await risk.check();
  await expect(page.getByRole("heading", { name: "Bengaluru", exact: true })).toBeVisible();
  await expect(page.getByText("Road flood risk · next 3 hours")).toBeVisible();
  await expect(page.getByText("No Bengaluru cells reach 1 mm of modeled runoff in this forecast.")).toBeVisible();
  expect(forecastRequests).toBeGreaterThan(0);
  await risk.uncheck();
  await expect(page.getByText("Road flood risk · next 3 hours")).toHaveCount(0);
});

test("road risk falls back to the central forecast and municipal model", async ({ page }) => {
  await page.route("https://basemaps.cartocdn.com/**", (route) =>
    route.fulfill({ json: { version: 8, layers: [], sources: {} } }));
  const headers = { "access-control-allow-origin": "*" };
  let rainfall: string | null = null;
  const now = new Date();
  await page.route("http://localhost:8000/api/**", (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case "/api/scenarios":
      case "/api/critical-infrastructure":
        return route.fulfill({ headers, json: [] });
      case "/api/weather/nowcast":
        return route.fulfill({ headers, json: {
          status: "ready", valid_at: now.toISOString(), recent_rain_mm: 10, upcoming_rain_mm: 42,
          air_temperature_c: 25, feels_like_c: 26, hourly_forecast: [],
          forecast_through: new Date(now.getTime() + 10_800_000).toISOString(),
          provenance: { retrieved_at: now.toISOString(), grid_cell_center: { latitude: 12.98, longitude: 77.59 } },
        } });
      case "/api/flood/city":
        rainfall = url.searchParams.get("rainfall_mm");
        return route.fulfill({ headers, json: {
          status: "ready", grid_m: 300, cells: [{ screen_mm: 0, rings: [] }],
        } });
      default:
        return route.fulfill({ headers, json: { status: "unavailable", message: "Weather upstream failed." } });
    }
  });
  await page.goto("/");
  await page.getByRole("checkbox", { name: "Road flood risk", exact: true }).check();
  await expect(page.getByText("No Bengaluru cells reach 1 mm of modeled runoff in this forecast.")).toBeVisible();
  await expect(page.getByText(/1 forecast point · includes recent rain/)).toBeVisible();
  expect(rainfall).toBe("52");
});
