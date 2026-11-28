import { expect, test } from "@playwright/test";
import type { StormBacktest } from "../src/api/client";

test("plays the published snapshots without substituting a CityShield match", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await page.route("http://localhost:8000/api/**", (route) => route.abort());
  await page.route("**/api/backtest", (route) => route.fulfill({ status: 404, json: { detail: "Not Found" } }));
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Console workspaces" });
  const open = navigation.getByRole("button", { name: "Storm replay", exact: true });
  await open.click();
  const replay = page.getByRole("region", { name: "October 2020 Bengaluru storm" });
  const observed = replay.getByRole("region", { name: "Published sensor reading" });
  const modeled = replay.getByRole("region", { name: "Published model peak" });

  await expect(replay).toContainText("Snapshot 1 of 5");
  await expect(observed).toContainText("0.79 m");
  await expect(observed).toContainText("20:30");
  await expect(modeled).toContainText("0.8124 m");
  await expect(modeled).toContainText("19:15");
  await expect(replay).toContainText("a different time from the Table S3 reading");
  await replay.getByRole("button", { name: "Find imported storms" }).click();
  await expect(replay.getByText("Imported storm comparisons are unavailable on this server.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.clock.install();
  await replay.getByRole("button", { name: "Play replay" }).click();
  await page.clock.runFor(2500);
  await expect(replay).toContainText("Snapshot 2 of 5");
  await expect(modeled).toContainText("Table S6 gives no model peak for this sensor.");
  await replay.getByRole("button", { name: "Pause replay" }).click();
  await page.clock.runFor(5000);
  await expect(replay).toContainText("Snapshot 2 of 5");

  await replay.getByRole("button", { name: /Vrishabhavathi Nagar/ }).click();
  await expect(observed).toContainText("2.332 m");
  await expect(modeled).toContainText("0.6859 m");
  await expect(replay).toContainText("Table S6 reports 0.90 m");
  await replay.getByRole("button", { name: "Next", exact: true }).click();
  await expect(replay).toContainText("Snapshot 5 of 5");
  await expect(replay.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await replay.getByRole("button", { name: "Play replay" }).click();
  await expect(replay).toContainText("Snapshot 1 of 5");

  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(open).toBeFocused();
  await expect(page.getByRole("heading", { name: "India-wide weather map", exact: true })).toBeVisible();

  await open.click();
  await page.getByRole("searchbox", { name: "Search India" }).fill("Bellandur");
  await page.getByRole("button", { name: "Bellanduru East", exact: true }).click();
  await expect(replay).toBeHidden();
  await expect(page.getByRole("heading", { name: "Bellanduru", level: 1 })).toBeVisible();
});

test("shows imported rainfall and paired depths with the signed peak delay", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const comparison: StormBacktest = {
    status: "ready", event_id: "test-storm", storm_group_id: "test-group", catchment_id: "test-catchment",
    partition: "holdout", network_id: "test-net", network_version: "1", interval_minutes: 15,
    model: { name: "Test drainage run", version: "1", source_url: null, run_reference: "test-run-1" },
    observation_source: { title: "Test gauge archive", url: "https://example.org/rain" },
    sensors: [{
      id: "sensor-a", name: null, node_id: "node-a", gauge_id: "gauge-a", latitude: 13, longitude: 77.6,
      series: [
        { timestamp: "2020-10-21T01:15:00Z", rainfall_mm: 2, observed_depth_m: 0.6, modeled_depth_m: 0.4 },
        { timestamp: "2020-10-21T01:30:00Z", rainfall_mm: 1, observed_depth_m: 0.2, modeled_depth_m: 0.5 },
      ],
      metrics: { sample_count: 2, mae_m: 0.25, observed_peak_m: 0.6, modeled_peak_m: 0.5,
        observed_peak_at: "2020-10-21T01:15:00Z", modeled_peak_at: "2020-10-21T01:30:00Z", peak_timing_error_minutes: 15 },
    }],
    limitations: ["Fixture values for browser testing."],
  };
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await page.route("http://localhost:8000/api/**", (route) => route.abort());
  await page.route("**/api/backtest", (route) => route.fulfill({ json: { events: [{
    event_id: "test-storm", catchment_id: "test-catchment", partition: "holdout", status: "ready", message: null,
  }] } }));
  await page.route("**/api/backtest/test-storm", (route) => route.fulfill({ json: comparison }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Console workspaces" }).getByRole("button", { name: "Storm replay" }).click();
  const panel = page.getByRole("region", { name: "CityShield comparison" });
  await panel.getByRole("button", { name: "Find imported storms" }).click();
  await panel.getByRole("button", { name: "Compare storm" }).click();
  await expect(panel).toContainText("0.25 m");
  await expect(panel).toContainText("15 min late");
  await expect(panel.getByRole("link", { name: "Test gauge archive" })).toHaveAttribute("href", "https://example.org/rain");
  const slider = panel.getByRole("slider", { name: "Pick a time on the storm timeline" });
  await slider.focus();
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", /07:00 IST/);
  await panel.getByText("Readings table", { exact: true }).click();
  await expect(panel.getByRole("table", { name: "Paired storm readings" }).getByRole("row")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
