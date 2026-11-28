import { expect, test, type Route } from "@playwright/test";

const headers = { "access-control-allow-origin": "*" };

async function respond(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
}

test("nationwide combined layer screens rain and heat without enabling either source layer", async ({ page }) => {
  let requested = false;
  await page.route("https://basemaps.cartocdn.com/**", (route) =>
    route.fulfill({ json: { version: 8, layers: [], sources: {} } }));
  await page.route("http://localhost:8000/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/scenarios") return respond(route, []);
    if (url.pathname === "/api/critical-infrastructure") return respond(route, []);
    if (url.pathname === "/api/weather/grid") {
      requested = true;
      const body = route.request().postDataJSON() as { locations: { id: string; lat: number; lng: number }[] };
      return respond(route, {
        status: "ready", checked_locations: body.locations.length, unavailable_locations: 0,
        checked_at: new Date().toISOString(),
        results: body.locations.map((cell) => ({
          id: cell.id, air_temperature_2m_c: 37, feels_like_2m_c: 40, relative_humidity_pct: 55,
          wind_speed_kmh: 8, rainfall_24h_mm: 25,
          model_grid_center: { latitude: cell.lat, longitude: cell.lng }, model_run: new Date().toISOString(),
          valid_start: new Date().toISOString(), valid_end: new Date(Date.now() + 86_400_000).toISOString(),
          retrieved_at: new Date().toISOString(), stale: false,
        })),
      });
    }
    return route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const flood = page.getByRole("checkbox", { name: "Flood", exact: true });
  const heat = page.getByRole("checkbox", { name: "Heat" });
  const combined = page.getByRole("checkbox", { name: "Combined", exact: true });
  await expect(flood).toBeVisible();
  await expect(flood).not.toBeChecked();
  await expect(heat).not.toBeChecked();
  await combined.check();
  await expect(combined).toBeChecked();
  await expect(flood).not.toBeChecked();
  await expect(heat).not.toBeChecked();
  await expect(page.getByText("Rain ≥20 mm and air temperature ≥35 °C")).toBeVisible();
  await expect(page.getByText(/thresholds are not locally calibrated/i)).toBeVisible();
  await expect.poll(() => requested).toBe(true);
});

test("citizen reports remain local, unverified, and removable", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/scenarios") return respond(route, []);
    if (url.pathname === "/api/critical-infrastructure") return respond(route, []);
    if (url.pathname === "/api/places/search") return respond(route, { status: "ready", results: [{
      id: "bengaluru-test", name: "Bengaluru, Karnataka, India", category: "city", lat: 12.9719, lng: 77.5937,
    }] });
    return route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const search = page.getByRole("searchbox", { name: "Search India" });
  await search.fill("Bengaluru");
  await page.getByRole("button", { name: "Bengaluru, Karnataka, India" }).click();
  await page.getByRole("button", { name: "Open map tools" }).click();
  await page.getByRole("button", { name: "Data & models" }).click();
  await expect(page.getByRole("link", { name: "112" })).toHaveAttribute("href", "tel:112");
  await page.getByLabel("Details (optional)").fill("Water across the access road");
  await page.getByRole("button", { name: "Save unverified report" }).click();
  await expect(page.getByText("Saved in this browser. It has not been shared or verified.")).toBeVisible();
  await expect(page.getByText("Waterlogging · Unverified")).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Waterlogging · Unverified")).toHaveCount(0);
});
