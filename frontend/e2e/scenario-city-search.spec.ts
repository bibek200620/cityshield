import { expect, test } from "@playwright/test";

test("scenario city search filters the picker and keeps rainfall controls open", async ({ page }) => {
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await page.route("http://localhost:8000/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const result = ["/api/scenarios", "/api/critical-infrastructure"].includes(path)
      ? [] : { status: "unavailable" };
    return route.fulfill({ json: result });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search cities" });
  const picker = page.getByRole("combobox", { name: "Simulation area" });
  const run = page.getByRole("button", { name: "Run local simulation" });
  await expect(search).toBeEnabled();

  await search.fill("Mysuru Karnataka");
  await expect(picker.getByRole("option", { name: /Mysuru/ })).toHaveCount(1);
  await expect(picker.getByRole("option", { name: /Bengaluru/ })).toHaveCount(0);
  await picker.selectOption({ value: "1262321" });
  await expect(page.getByRole("heading", { name: "Mysuru, Karnataka" })).toBeVisible();
  await expect(run).toBeDisabled();

  await search.fill("no such city");
  await expect(page.getByText("No cities match your search.")).toBeVisible();
  await expect(picker).toBeDisabled();

  await search.fill("Bangalore");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "Bengaluru, Karnataka" })).toBeVisible();
  await expect(search).toHaveValue("");
  await expect(run).toBeEnabled();
});
