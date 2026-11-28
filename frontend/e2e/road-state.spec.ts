import { expect, test, type Route } from "@playwright/test";

async function respond(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test("Bengaluru Road State screens current, forecast and what-if rainfall with honest history limits", async ({ page }) => {
  const screenedRainfall: number[] = [];
  const pageErrors: string[] = [];
  let failScreening = false;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const now = new Date().toISOString();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/scenarios") return respond(route, []);
    if (url.pathname === "/api/critical-infrastructure") return respond(route, []);
    if (url.pathname === "/api/weather/nowcast") return respond(route, {
      status: "ready", is_stale: false,
      provenance: { model_note: "Test forecast", cell_selection: "nearest", requested_location: { latitude: 12.97194, longitude: 77.59369 },
        grid_cell_center: { latitude: 12.97, longitude: 77.59, elevation_m: 900 }, spatial_resolution_m: 1000,
        spatial_resolution_note: "Grid", timezone: "Asia/Kolkata", utc_offset_seconds: 19800, timestamps_are_unix_utc: true,
        units: { air_temperature: "°C", apparent_temperature: "°C", relative_humidity: "%", precipitation: "mm" }, retrieved_at: now },
      valid_at: now, air_temperature_c: 28, feels_like_c: 29, recent_rain_mm: 4.5, recent_through: now,
      upcoming_rain_mm: 3, forecast_through: now, hourly_forecast: [],
    });
    if (url.pathname === "/api/weather/report") return respond(route, {
      status: "ready", forecast_hours: 48, forecast_from: now, forecast_through: now,
      provenance: { model_note: "Test forecast", cell_selection: "nearest", requested_location: { latitude: 12.97194, longitude: 77.59369 },
        grid_cell_center: { latitude: 12.97, longitude: 77.59, elevation_m: 900 }, spatial_resolution_m: 1000,
        spatial_resolution_note: "Grid", timezone: "Asia/Kolkata", utc_offset_seconds: 19800, timestamps_are_unix_utc: true,
        units: { air_temperature: "°C", apparent_temperature: "°C", relative_humidity: "%", precipitation: "mm" }, retrieved_at: now },
      hourly_forecast: Array.from({ length: 48 }, (_, index) => ({ valid_at: now, air_temperature_c: 28,
        feels_like_c: 29, relative_humidity_pct: 70, precipitation_mm: index + 1 })),
    });
    if (url.pathname === "/api/flood/city") {
      screenedRainfall.push(Number(url.searchParams.get("rainfall_mm")));
      if (failScreening) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Screening service unavailable" }) });
      return respond(route, { status: "ready", rainfall_mm: Number(url.searchParams.get("rainfall_mm")), grid_m: 300,
        source: "Terrain screen", model: "Runoff screen", cells: [{ id: "cell-1", rings: [[[77.59, 12.97], [77.60, 12.97], [77.60, 12.98], [77.59, 12.97]]], screen_mm: 8, depressed_land_percent: 20 }] });
    }
    if (url.pathname === "/api/flood/events") return respond(route, {
      status: "ready", location: "Bengaluru Urban district", location_precision: "district",
      events: [{ id: "event-1", start_date: "2020-08-10", end_date: "2020-08-10", date_precision: "day",
        reported_cause: "Heavy rainfall", source_event_source: "Test inventory", districts_listed: ["Bengaluru Urban"],
        location_name: "Bengaluru Urban district", location_precision: "district", has_coordinates: false,
        multi_district_event: false, evaluation_eligible: false, quality_flags: [] }],
      limitations: ["No event footprints are available."], citation: { dataset: "Test inventory", doi: "10.0000/test", license: "CC BY 4.0" },
    });
    return route.continue();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "View Bengaluru" }).click();
  await expect(page.getByRole("heading", { name: "Bengaluru, Karnataka, India" })).toBeVisible();
  await page.getByRole("button", { name: "View all India" }).click();
  await expect(page.getByRole("heading", { name: "India-wide weather map" })).toBeVisible();
  await page.getByRole("button", { name: "Road State" }).click();
  await expect(page.getByRole("heading", { name: "Bengaluru road screening" })).toBeVisible();
  await expect(page.getByText("Recent 4.5 mm + upcoming 3.0 mm")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Run road screening" }).click();
  await expect(page.getByText(/Recent plus upcoming rain: 7\.5 mm/)).toBeVisible();

  await page.getByRole("radio", { name: "Forecast" }).check();
  await expect(page.getByLabel("Forecast window")).toBeVisible();
  await page.getByLabel("Forecast window").selectOption("3");
  await expect(page.getByText("6.0 mm", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run road screening" }).click();
  await expect(page.getByText(/Next 3 forecast hours: 6\.0 mm/)).toBeVisible();

  await page.getByRole("radio", { name: "What-if" }).check();
  await page.getByLabel("Rainfall total (mm)").fill("125");
  await page.getByRole("button", { name: "Run road screening" }).click();
  await expect(page.getByText(/User-set rainfall total: 125\.0 mm/)).toBeVisible();

  await page.getByRole("radio", { name: "History" }).check();
  await expect(page.getByText(/no road locations or flood footprints/)).toBeVisible();
  await expect(page.getByText("2020-08-10", { exact: true })).toBeVisible();
  await expect.poll(() => screenedRainfall).toEqual([7.5, 6, 125]);
  await page.getByRole("button", { name: "Screen historical gauge total · 124.5 mm" }).click();
  await expect(page.getByText(/Historical Kengeri gauge total: 124\.5 mm/)).toBeVisible();
  await expect(page.getByText(/not a city-wide rainfall reconstruction/)).toBeVisible();
  await expect.poll(() => screenedRainfall).toEqual([7.5, 6, 125, 124.5]);
  await page.getByRole("radio", { name: "What-if" }).check();
  await page.getByLabel("Rainfall total (mm)").fill("12");
  failScreening = true;
  await page.getByRole("button", { name: "Run road screening" }).click();
  await expect(page.getByRole("alert")).toContainText("Screening service unavailable");
  failScreening = false;
  await page.getByRole("button", { name: "Run road screening" }).click();
  await expect(page.getByText(/User-set rainfall total: 12\.0 mm/)).toBeVisible();
  await expect.poll(() => screenedRainfall).toEqual([7.5, 6, 125, 124.5, 12, 12]);
  await page.setViewportSize({ width: 390, height: 844 });
  const panelBounds = await page.locator("#map-tools").boundingBox();
  if (!panelBounds) throw new Error("Road State panel is not rendered at the mobile viewport.");
  expect(panelBounds.x).toBeGreaterThanOrEqual(0);
  expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(pageErrors).toEqual([]);
});
