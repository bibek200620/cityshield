import { expect, test } from "@playwright/test";

const headers = { "access-control-allow-origin": "*" };
const coordinates = [[77.637, 12.971], [77.651, 12.957], [77.662, 12.944], [77.677, 12.926]];

test("flood demo updates an existing trip, alerts CX, and moves the car without GPS", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", { value: {
      watchPosition: () => { document.body.dataset.gpsRequested = "true"; return 1; },
      clearWatch: () => {},
    } });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class {
      voice: SpeechSynthesisVoice | undefined;
      constructor(public text: string) {}
    } });
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [
        { name: "Basic", voiceURI: "basic", localService: true, lang: "en-IN", default: true },
        { name: "Tara Enhanced", voiceURI: "enhanced", localService: true, lang: "en-IN", default: false },
      ],
      cancel: () => {},
      speak: (utterance: SpeechSynthesisUtterance) => {
        document.body.dataset.spoken = utterance.text;
        document.body.dataset.voice = utterance.voice?.voiceURI;
      },
    } });
  });
  await page.route("**/api/weather/nowcast*", (route) => route.fulfill({ json: { status: "unavailable", reason: "stale_data" }, headers }));
  await page.route("**/api/weather/point-forecast*", (route) => route.fulfill({ status: 503, json: { detail: "Forecast unavailable" }, headers }));
  await page.route("**/api/assistant/outlook", (route) => route.fulfill({ json: { status: "unavailable" }, headers }));
  await page.route("**/api/scenarios", (route) => route.fulfill({ json: [], headers }));
  await page.route("**/api/critical-infrastructure", (route) => route.fulfill({ json: [], headers }));
  await page.route("**/api/simulate", (route) => {
    expect(route.request().postDataJSON()).toEqual({ rainfall_intensity_mm_hr: 100, duration_min: 120 });
    return route.fulfill({ json: { scenario_id: "demo", node_predictions: [], road_segments: [], at_risk_infra_ids: [] }, headers });
  });
  await page.route("**/api/flood/city?*", (route) => route.fulfill({
    json: { status: "ready", rainfall_mm: Number(new URL(route.request().url()).searchParams.get("rainfall_mm")),
      grid_m: 300, source: "fixture", model: "fixture", cells: [] }, headers,
  }));
  await page.route("**/api/exposure/demo", (route) => route.fulfill({ json: { status: "unavailable", cells: [] }, headers }));
  await page.route("**/api/places/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("query");
    const source = query === "Indiranagar";
    if (query === "Bengaluru") return route.fulfill({ json: { status: "ready", results: [{
      id: "bengaluru", name: "Bengaluru, Karnataka, India", category: "city", lng: 77.5937, lat: 12.9719,
    }] }, headers });
    return route.fulfill({ json: { status: "ready", results: [{
      id: source ? "s" : "d", name: source ? "Indiranagar" : "Bellandur", category: "suburb",
      lng: source ? 77.637 : 77.677, lat: source ? 12.971 : 12.926,
    }] }, headers });
  });
  await page.route("**/api/drive/routes", (route) => route.fulfill({ json: {
    source: "TomTom Routing", shortest_available: true, runoff_available: true,
    traffic: { status: "ready", message: "Traffic-aware estimate", checked_at: new Date().toISOString() },
    weather: { status: "unavailable", message: "Forecast unavailable" }, flood_reports: { status: "unavailable" },
    routes: [{ id: "0", labels: ["Best estimated time"], distance_km: 7, eta_seconds: 600, coordinates }],
  }, headers }));
  await page.route("**/api/drive/traffic-flow", (route) => route.fulfill({ json: {
    status: "ready", checked_at: new Date().toISOString(), segments: [
      { start_index: 0, end_index: 1, level: "slow" }, { start_index: 1, end_index: 2, level: "heavy" },
      { start_index: 2, end_index: 3, level: "unknown" },
    ],
  }, headers }));
  await page.route("**/api/drive/scenario", (route) => {
    expect(route.request().postDataJSON()).toEqual({ rainfall_mm: 200, routes: [coordinates] });
    return route.fulfill({ json: { status: "ready", routes: [{
      route_km: 7, covered_km: 7, exposed_km: 4, high_km: 1,
      spans: [{ start: .06, end: .7 }], high_spans: [{ start: .4, end: .54 }],
    }] }, headers });
  });

  await page.goto("/");
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await button("CX assistant").click();
  await expect(page.locator("body")).toHaveAttribute("data-voice", "enhanced");
  await button("Enable spoken alerts").click();
  await button("Close CX bubble").click();

  await button("Open map tools").click();
  await button("Car routes").click();
  await page.getByRole("searchbox", { name: "Search source by place name" }).fill("Indiranagar");
  await button("Indiranagar suburb").click();
  await page.getByRole("searchbox", { name: "Search destination by place name" }).fill("Bellandur");
  await button("Bellandur suburb").click();
  await button("Compare car routes").click();
  await expect(page.getByText("10 min current route estimate · 7.0 km")).toBeVisible();
  await expect(page.getByText(/min demo ETA/)).toHaveCount(0);

  await button("Back to map tools").click();
  const mapSearch = page.getByRole("searchbox", { name: "Search India" });
  await mapSearch.fill("Bengaluru");
  await button("Bengaluru, Karnataka, India").click();
  await button("Scenarios").click();
  await page.getByLabel("Preset").selectOption("flood-demo");
  await button("Run local simulation").click();
  await expect(page.getByText("Flood demo running", { exact: true }).last()).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /Flood demo is running/);

  await button("Back to map tools").click();
  await button("Car routes").click();
  await expect(page.getByText("10 min current route estimate · 7.0 km")).toBeVisible();
  await expect(page.getByText("28 min demo ETA")).toBeVisible();
  await expect(page.getByText("· 4.00 km screened for runoff", { exact: false })).toBeVisible();
  await expect(page.getByText("Scenario runoff along route")).toBeVisible();
  await page.clock.install();
  await button("Start car simulation").click();
  await expect(page.getByRole("img", { name: "Simulated car location" })).toBeVisible();
  await expect(page.getByText("Simulated flood exposure ahead", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Slow traffic ahead", { exact: true })).toBeVisible();
  await page.clock.fastForward(13_000);
  await expect(page.getByText("Heavy delay ahead", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("data-gps-requested");
  await button("Stop car simulation").click();
  await expect(page.getByRole("img", { name: "Simulated car location" })).toHaveCount(0);
  await button("Open map tools").click();
  await button("Rainfall scenario").click();
  await button("Stop simulation").click();
  await expect(page.getByText("Flood demo running", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Scenario runoff along route")).toHaveCount(0);
});

test("the forecast report shows rain, flood and heat evidence and exports on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const start = Date.now();
  const hours = Array.from({ length: 48 }, (_, index) => ({
    valid_at: new Date(start + (index + 1) * 3_600_000).toISOString(),
    air_temperature_c: 28, feels_like_c: 42, relative_humidity_pct: 75, precipitation_mm: index === 3 ? 8 : 0,
  }));
  await page.route("**/api/weather/report*", (route) => route.fulfill({ json: {
    status: "ready", source: "Open-Meteo", forecast_from: hours[0].valid_at, forecast_through: hours[47].valid_at,
    forecast_hours: 48, hourly_forecast: hours,
    provenance: { retrieved_at: new Date(start).toISOString(), grid_cell_center: { latitude: 12.98, longitude: 77.59 } },
  }, headers }));
  await page.route("**/api/assistant/outlook", (route) => route.fulfill({ json: {
    status: "ready", checked_at: new Date(start).toISOString(), forecast_through: hours[2].valid_at, forecast_points: 5,
    alert: { cells: 23, valid_at: hours[1].valid_at }, heat: { feels_like_c: 42, valid_at: hours[0].valid_at },
  }, headers }));
  await page.goto("/");
  await page.getByRole("button", { name: "Open map tools" }).click();
  await page.getByRole("button", { name: "Two-day weather report" }).click();
  const report = page.getByRole("complementary", { name: "Two-day weather report" });
  await expect(report.getByRole("region", { name: "Hourly rain outlook" })).toContainText("8.0 mm");
  await expect(report.getByRole("heading", { name: "Next 24 hours · Bengaluru" })).toBeVisible();
  await expect(report.getByText("Rain total", { exact: true }).first()).toBeVisible();
  await expect(report.getByText("Peak feels like", { exact: true }).first()).toBeVisible();
  const download = page.waitForEvent("download");
  await report.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/cityshield-bengaluru-48h-.*\.csv$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
