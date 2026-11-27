import { expect, test } from "@playwright/test";

const headers = { "access-control-allow-origin": "*" };
const now = new Date("2026-11-27T14:45:00Z");
const currentHour = Math.floor(now.getTime() / 3_600_000) * 3600;
const time = Array.from({ length: 51 }, (_, index) => currentHour + (index - 2) * 3600);
const units = {
  time: "unixtime", temperature_2m: "°C", apparent_temperature: "°C",
  relative_humidity_2m: "%", precipitation: "mm",
};

for (const stale of [false, true]) {
  test(stale ? "stale fallback weather remains unavailable" : "weather panels share a fresh fallback forecast", async ({ page }) => {
    await page.clock.setFixedTime(now);
    await page.route(/\/api\/weather\/(nowcast|report)(?:\?.*)?$/, (route) => route.fulfill({
      headers,
      json: { status: "unavailable", reason: "provider_error", message: "The weather provider could not be reached." },
    }));
    let providerCalls = 0;
    await page.route("https://api.open-meteo.com/v1/forecast?*", (route) => {
      providerCalls++;
      const query = new URL(route.request().url()).searchParams;
      expect(query.get("latitude")).toBe("12.98");
      expect(query.get("longitude")).toBe("77.59");
      expect(query.get("forecast_hours")).toBe("49");
      return route.fulfill({ headers, json: {
        latitude: 12.97, longitude: 77.56, elevation: 924, timezone: "GMT", utc_offset_seconds: 0,
        current_units: units, hourly_units: units,
        current: { time: currentHour - (stale ? 7200 : 0), temperature_2m: 28, apparent_temperature: 30 },
        hourly: {
          time, temperature_2m: time.map(() => 28), apparent_temperature: time.map(() => 30),
          relative_humidity_2m: time.map(() => 75), precipitation: time.map(() => 2),
        },
      } });
    });
    await page.goto("/");
    const card = page.getByRole("button", { name: "Open next 3 hours forecast" });
    if (stale) {
      await expect(card).toContainText("Forecast unavailable");
      expect(providerCalls).toBe(1);
      return;
    }
    await expect(card.getByLabel("Current estimate 28° Celsius")).toBeVisible();
    await page.getByRole("button", { name: "Open map tools" }).click();
    await page.getByRole("button", { name: "Two-day weather report" }).click();
    const report = page.getByRole("complementary", { name: "Two-day weather report" });
    await expect(report.getByRole("button", { name: "Export CSV" })).toBeEnabled();
    expect(providerCalls).toBe(1);
  });
}

test("Open-Meteo fallback follows a selected Indian city", async ({ page }) => {
  await page.clock.setFixedTime(now);
  const hours = Array.from({ length: 51 }, (_, index) => currentHour + (index - 2) * 3600);
  await page.route("**/api/places/search?*", (route) => route.fulfill({ headers, json: {
    status: "ready", results: [{ id: "mumbai", name: "Mumbai, Maharashtra, India", category: "city", lat: 19.076, lng: 72.8777 }],
  } }));
  await page.route("**/api/weather/nowcast*", (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("latitude") === "19.076") return route.fulfill({ headers, json: {
      status: "unavailable", reason: "provider_error", message: "The weather provider could not be reached.",
    } });
    return route.fulfill({ headers, json: {
      status: "ready", source: "Open-Meteo", air_temperature_c: 28, feels_like_c: 30,
      weather_code: 3, hourly_forecast: [], valid_at: new Date(currentHour * 1000).toISOString(),
      upcoming_rain_mm: 0, recent_rain_mm: 0,
      provenance: { retrieved_at: new Date(currentHour * 1000).toISOString(), grid_cell_center: { latitude: 12.98, longitude: 77.59 } },
    } });
  });
  await page.route("https://api.open-meteo.com/v1/forecast?*", (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("latitude")).toBe("19.076");
    expect(query.get("longitude")).toBe("72.8777");
    return route.fulfill({ headers, json: {
      latitude: 19.08, longitude: 72.88, elevation: 14, timezone: "UTC", utc_offset_seconds: 0,
      current_units: { time: "unixtime", temperature_2m: "°C", apparent_temperature: "°C" },
      hourly_units: units,
      current: { time: currentHour, temperature_2m: 29, apparent_temperature: 31, weather_code: 3, is_day: 1 },
      hourly: {
        time: hours, temperature_2m: hours.map(() => 29), apparent_temperature: hours.map(() => 31),
        relative_humidity_2m: hours.map(() => 70), precipitation: hours.map(() => 0),
        weather_code: hours.map(() => 3), is_day: hours.map(() => 1),
      },
    } });
  });
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search India" });
  await search.fill("Mumbai");
  await page.getByRole("button", { name: "Mumbai, Maharashtra, India" }).click();
  const card = page.getByRole("button", { name: "Open next 3 hours forecast" });
  await expect(card.getByLabel("Current estimate 29° Celsius")).toBeVisible();
  await card.click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Mumbai forecast" })).toBeVisible();
});
