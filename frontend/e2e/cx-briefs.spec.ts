import { expect, test } from "@playwright/test";

test("CX greets on open and uses exactly the requested forecast duration", async ({ page }) => {
  const forecastStart = Date.UTC(2026, 10, 26, 3);
  const forecast = Array.from({ length: 48 }, (_, index) => ({
    valid_at: new Date(forecastStart + index * 3_600_000).toISOString(),
    air_temperature_c: 22 + index,
    feels_like_c: 23 + index,
    precipitation_mm: index === 10 ? 99 : 1,
    relative_humidity_pct: 70,
  }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        getVoices: () => [],
        cancel: () => {},
        speak: (utterance: SpeechSynthesisUtterance) => document.body.dataset.spoken = utterance.text,
      },
    });
  });
  await page.route("**/api/weather/report*", (route) => route.fulfill({
    json: {
      status: "ready", source: "Open-Meteo", forecast_hours: 48,
      forecast_from: forecast[0].valid_at, forecast_through: forecast[47].valid_at, hourly_forecast: forecast,
      provenance: { retrieved_at: forecast[0].valid_at },
    },
    headers: { "access-control-allow-origin": "*" },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "CX assistant", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-spoken", "Hi!");
  await page.getByRole("button", { name: "Forecast report", exact: true }).click();
  await page.getByLabel("Forecast duration in hours").fill("10");
  await page.getByRole("button", { name: "Get report" }).click();
  const report = page.getByRole("region", { name: "Completed forecast report" });
  await expect(report).toContainText("10.0 mm");
  await expect(report).toContainText("22.0–31.0 °C");
  await report.getByText("Show 10 hourly estimates").click();
  await expect(report.getByRole("table").getByRole("row")).toHaveCount(11);
  await report.getByRole("button", { name: "Read report" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /next 10 hours/);
});

test("CX traffic uses selected endpoints, provider ETA and modeled runoff", async ({ page }) => {
  await page.route("**/api/places/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("query");
    const place = query === "Bellandur"
      ? { id: "s", name: "Bellandur", lat: 12.93, lng: 77.67, category: "suburb" }
      : { id: "d", name: "Whitefield", lat: 12.97, lng: 77.75, category: "suburb" };
    return route.fulfill({ json: { status: "ready", results: [place] }, headers: { "access-control-allow-origin": "*" } });
  });
  await page.route("**/api/drive/routes", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      source: { lat: 12.93, lng: 77.67 }, destination: { lat: 12.97, lng: 77.75 },
    });
    return route.fulfill({
      json: {
        source: "TomTom Routing", shortest_available: true, runoff_available: true,
        traffic: { status: "ready", message: "TomTom traffic-aware travel times." },
        weather: { status: "ready", upcoming_rain_mm: 5.4 },
        flood_reports: { status: "ready", source: "TomTom Traffic Incidents" },
        routes: [{
          id: "0", labels: ["Best estimated time"], distance_km: 10.8, eta_seconds: 1_200,
          coordinates: [[77.67, 12.93], [77.75, 12.97]], traffic_time_delta_seconds: 180,
          traffic_segments: [{ start_index: 0, end_index: 1, level: "slow" }], nearby_flood_reports: 1,
          runoff: { current_km: 0.2, forecast_km: 0.7, covered_km: 10.8 },
        }],
      },
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "CX assistant", exact: true }).click();
  await page.getByRole("button", { name: "Traffic", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search source by place name" }).fill("Bellandur");
  await page.getByRole("button", { name: "Bellandur suburb" }).click();
  await page.getByRole("searchbox", { name: "Search destination by place name" }).fill("Whitefield");
  await page.getByRole("button", { name: "Whitefield suburb" }).click();
  await page.getByRole("button", { name: "Check traffic" }).click();
  const report = page.getByRole("region", { name: "Completed traffic report" });
  await expect(report.getByRole("heading")).toHaveText("20 min · 10.8 km");
  await expect(report).toContainText("Slow traffic was reported");
  await expect(report).toContainText("5.4 mm");
  await expect(report).toContainText("0.70 km with forecast rain");
  await expect(report).toContainText("1 nearby flood report");
});
