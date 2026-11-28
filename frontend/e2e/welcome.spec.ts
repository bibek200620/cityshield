import { expect, test } from "@playwright/test";

test("the welcome page and atlas link to each other with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 720 });
  const globeRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/ascend-d9857ad1f2/")) globeRequests.push(request.url());
  });

  await page.goto("/welcome");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Plan the road ahead/);
  await expect(page.locator(".landing-globe-fallback")).toBeVisible();
  await expect(page.locator(".landing-globe canvas")).toHaveCount(0);
  expect(globeRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  await page.getByRole("link", { name: "Explore the research" }).click();
  await expect(page).toHaveURL(/\/welcome#research$/);
  await expect(page.getByText("124.5 mm", { exact: true })).toBeVisible();

  await page.getByRole("main").getByRole("link", { name: "Open the atlas" }).last().click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("main", { name: "India map" })).toBeVisible();
  await page.getByRole("link", { name: "About CityShield" }).click();
  await expect(page).toHaveURL("/welcome");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
