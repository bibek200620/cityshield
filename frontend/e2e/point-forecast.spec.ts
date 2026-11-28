import { expect, test, type Route } from "@playwright/test";

const headers = { "access-control-allow-origin": "*" };

async function respond(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
}

test("selected-city point forecast and five-day chart use the backend without provider branding", async ({ page }) => {
  const now = Date.now();
  const hours = Array.from({ length: 8 }, (_, index) => ({
    valid_at: new Date(now + index * 3_600_000).toISOString(),
    air_temperature_c: 29, feels_like_c: 32, precipitation_mm: index === 2 ? 4 : 0,
    relative_humidity_pct: 68, pictocode: 3,
  }));
  let selectedCityRequested = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/scenarios") return respond(route, []);
    if (url.pathname === "/api/critical-infrastructure") return respond(route, []);
    if (url.pathname === "/api/places/search") return respond(route, { status: "ready", results: [{
      id: "mumbai", name: "Mumbai, Maharashtra, India", category: "city", lat: 19.076, lng: 72.8777,
    }] });
    if (url.pathname === "/api/weather/nowcast") return respond(route, { status: "unavailable", message: "Unavailable in test." });
    if (url.pathname === "/api/weather/point-forecast") {
      const query = url.searchParams;
      const latitude = Number(query.get("latitude"));
      const longitude = Number(query.get("longitude"));
      if (Math.abs(latitude - 19.076) < 0.001) selectedCityRequested = true;
      return respond(route, {
        location: { latitude, longitude }, model_run: new Date(now).toISOString(),
        model_updated_at: new Date(now).toISOString(), retrieved_at: new Date(now).toISOString(),
        current: { valid_at: new Date(now).toISOString(), air_temperature_c: 29, feels_like_c: 32,
          heat_index_c: 31, relative_humidity_pct: 68, wind_speed_kmh: 8, uv_index: 4,
          precipitation_1h_mm: 0, condition: "Cloudy" },
        hours,
      });
    }
    if (url.pathname === "/api/weather/air-quality") {
      return respond(route, { status: "ready", checked_at: new Date(now).toISOString(),
        valid_at: new Date(now).toISOString(), indexes: [{ name: "Universal AQI", value: 62,
          category: "Moderate", dominant_pollutant: "pm25" }], pollutants: [], limitations: [] });
    }
    return route.continue();
  });

  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search India" });
  await search.fill("Mumbai");
  await page.getByRole("button", { name: "Mumbai, Maharashtra, India" }).click();
  const preview = page.getByRole("button", { name: "Open next 3 hours forecast" });
  await expect(preview).toContainText("29°");
  await expect.poll(() => selectedCityRequested).toBe(true);
  const legend = page.getByRole("region", { name: "Map legend" });
  await expect(legend).toBeVisible();
  const legendFollowsForecast = await legend.evaluate((element) => {
    const legendBounds = element.getBoundingClientRect();
    const forecastBounds = document.querySelector(".weather-preview")!.getBoundingClientRect();
    return legendBounds.top >= forecastBounds.bottom;
  });
  expect(legendFollowsForecast).toBe(true);
  await preview.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Mumbai forecast" })).toBeVisible();
  await expect(dialog.getByText("Hourly point forecast for Mumbai.")).toBeVisible();
  await dialog.getByRole("button", { name: "Load point forecast" }).click();
  await dialog.getByRole("button", { name: "Show 5-day chart" }).click();
  await expect(dialog.getByRole("img", { name: "Five-day air-temperature forecast chart for Mumbai" })).toBeVisible();
  await expect(dialog.getByText("Universal AQI: 62")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/meteoblue|open-meteo/i);
  await dialog.getByRole("button", { name: "Close forecast" }).click();
  await expect(legend).toBeVisible();
});
