import { expect, test, type Route } from "@playwright/test";

async function respond(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test("daily surface temperature is a separate imagery layer from the forecast hexes", async ({ page }) => {
  let imageryRequested = false;
  let weatherGridRequested = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/scenarios") return respond(route, []);
    if (url.pathname === "/api/critical-infrastructure") return respond(route, []);
    if (url.pathname === "/api/weather/grid") weatherGridRequested = true;
    return route.continue();
  });
  await page.route("https://gibs.earthdata.nasa.gov/**", async (route) => {
    imageryRequested = true;
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hyoAAAAASUVORK5CYII=", "base64",
    ) });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const imagery = page.getByRole("checkbox", { name: /Surface temperature/ });
  await expect(imagery).toBeVisible();
  await imagery.check();
  await expect(page.getByText(/land-surface temperature, not air temperature or a forecast/i)).toBeVisible();
  await expect.poll(() => imageryRequested).toBe(true);
  expect(weatherGridRequested).toBe(false);
});
