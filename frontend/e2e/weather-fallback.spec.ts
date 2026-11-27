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
