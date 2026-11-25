import { expect, test, type Page, type Route } from "@playwright/test";

const SCENARIO_ID = "test-scenario-60-90";

const unavailableHeat = {
  status: "unavailable",
  message: "Test fixture: compatible Landsat scene unavailable.",
  source: "Synthetic browser fixture",
  provenance_class: "remotely_sensed",
  output_kind: "Modelled land-surface temperature (LST)",
  scene_id: null,
  acquisition_date: null,
  generated_at_utc: null,
  model_version: null,
  crs: null,
  pixel_resolution_m: null,
  hotspot_threshold_c: null,
  hotspot_definition: "Unavailable test fixture.",
  cells: [],
  explanation_status: "unavailable",
  explanation_message: "No test explanation artifact.",
  explanation_sample_pixels: null,
  feature_mean_abs_shap_c: {},
  limitations: ["Test fixture only; no observed values."],
};

const readyExposure = {
  status: "ready",
  message: "Cells meeting both elevation thresholds: 1.",
  scenario_id: SCENARIO_ID,
  grid_crs: "EPSG:32643",
  grid_resolution_m: 30,
  flood_elevated_threshold_m: 0.15,
  heat_elevated_definition: "Relative top decile in test fixture.",
  cells: [{
    grid_id: "test-cell-1",
    grid_i: 1,
    grid_j: 1,
    lng: 77.6,
    lat: 12.9,
    flood_depth_m: 0.16,
    flood_elevated: true,
    lst_c: 35,
    heat_elevated: true,
    both_elevated: true,
  }],
  limitations: ["Synthetic test fixture; no compound probability."],
};

const emptyExposure = {
  ...readyExposure,
  message: "No cells meet both elevation thresholds for this test scenario.",
  cells: [],
};

const unavailableExposure = {
  ...readyExposure,
  status: "unavailable",
  message: "Compatible Landsat test data are unavailable.",
  cells: [],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function respond(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockApi(
  page: Page,
  options: {
    exposure?: typeof readyExposure | typeof emptyExposure | typeof unavailableExposure | { status: number; body: unknown };
    exposureGate?: ReturnType<typeof deferred>;
    cityHeatAvailable?: boolean;
  } = {},
) {
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  if (options.cityHeatAvailable === false) {
    await page.route("**/data/bengaluru-heat.json", (route) => route.abort());
  }

  await page.route("http://localhost:8000/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/scenarios") {
      return respond(route, [{
        scenario_id: SCENARIO_ID,
        label: "Synthetic browser test scenario",
        rainfall_intensity_mm_hr: 60,
        duration_min: 90,
      }]);
    }
    if (url.pathname === "/api/critical-infrastructure") return respond(route, []);
    if (url.pathname === `/api/scenarios/${SCENARIO_ID}`) {
      return respond(route, {
        scenario_id: SCENARIO_ID,
        node_predictions: [],
        road_segments: [],
        model_caveat: "Synthetic browser test fixture only.",
        is_synthetic_ward: true,
        model_mode: "test fixture",
        model_version: "test-only",
        provenance_class: "simulated",
        rainfall_source: "Synthetic browser test input",
        generated_at_utc: "2026-11-26T00:00:00Z",
        input_provenance: ["Synthetic test fixture"],
        limitations: ["Test fixture only; not an observation."],
        at_risk_infra_ids: [],
      });
    }
    if (url.pathname === "/api/heat") {
      return respond(route, unavailableHeat);
    }
    if (url.pathname === "/api/flood/city") {
      return respond(route, {
        status: "ready",
        rainfall_mm: Number(url.searchParams.get("rainfall_mm")),
        grid_m: 300,
        source: "Synthetic browser test fixture",
        model: "Synthetic test only",
        cells: [{ id: "fixture-cell", rings: [[[77.6, 12.9], [77.601, 12.9], [77.601, 12.901], [77.6, 12.9]]], screen_mm: 12, depressed_land_percent: 20 }],
      });
    }
    if (url.pathname === `/api/exposure/${SCENARIO_ID}`) {
      if (options.exposureGate) await options.exposureGate.promise;
      if (options.exposure && "status" in options.exposure && typeof options.exposure.status === "number") {
        return respond(route, options.exposure.body, options.exposure.status);
      }
      return respond(route, options.exposure ?? readyExposure);
    }
    return route.continue();
  });
}

async function openMap(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("checkbox", { name: "Flood" })).toBeVisible();
}

test("Flood, Heat and Combined Exposure toggles are independent", async ({ page }) => {
  await mockApi(page, { exposure: unavailableExposure, cityHeatAvailable: false });
  await openMap(page);

  const flood = page.getByRole("checkbox", { name: "Flood" });
  const heat = page.getByRole("checkbox", { name: "Heat" });
  const combined = page.getByRole("checkbox", { name: "Combined exposure" });
  await expect(flood).toBeChecked();
  await expect(heat).not.toBeChecked();
  await expect(combined).not.toBeChecked();

  await heat.check();
  await expect(flood).toBeChecked();
  await expect(heat).toBeChecked();
  await expect(page.getByText("Landsat heat data unavailable.")).toBeVisible();
  await expect(page.getByText(/Bengaluru · .* mm scenario rainfall/)).toBeVisible();

  await flood.uncheck();
  await expect(heat).toBeChecked();
  await expect(combined).not.toBeChecked();
  await expect(page.getByText("Landsat heat data unavailable.")).toBeVisible();
  await expect(page.getByText(/Bengaluru · .* mm scenario rainfall/)).toHaveCount(0);

  await combined.check();
  await expect(heat).toBeChecked();
  await expect(page.getByText("Combined exposure needs both layers.")).toBeVisible();
});

test("combined loading and empty states remain separate from the source layers", async ({ page }) => {
  const gate = deferred();
  const exposureStarted = deferred();
  await mockApi(page, { exposure: emptyExposure, exposureGate: gate, cityHeatAvailable: false });
  page.on("request", (request) => {
    if (request.url().includes(`/api/exposure/${SCENARIO_ID}`)) exposureStarted.resolve();
  });
  await openMap(page);
  await exposureStarted.promise;

  await page.getByRole("checkbox", { name: "Combined exposure" }).check();
  await expect(page.getByText("Calculating exposure…")).toBeVisible();
  await gate.resolve();
  await expect(page.getByText("No cells meet both elevation thresholds for this test scenario.")).toBeVisible();
  await expect(page.getByText(/Bengaluru · .* mm scenario rainfall/)).toBeVisible();
  await expect(page.getByText("Landsat heat data unavailable.")).toHaveCount(0);
});

test("combined API errors do not hide the available flood layer", async ({ page }) => {
  await mockApi(page, {
    exposure: { status: 503, body: { detail: "Test exposure service unavailable" } },
    cityHeatAvailable: false,
  });
  await openMap(page);

  await page.getByRole("checkbox", { name: "Combined exposure" }).check();
  await expect(page.getByText("Combined exposure could not load.")).toBeVisible();
  await expect(page.getByText(/Bengaluru · .* mm scenario rainfall/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Flood" })).toBeChecked();
});

test("ready combined responses are presented without a compound probability claim", async ({ page }) => {
  await mockApi(page, { exposure: readyExposure });
  await openMap(page);

  await page.getByRole("checkbox", { name: "Combined exposure" }).check();
  await expect(page.getByText("Cells meeting both elevation thresholds: 1.")).toBeVisible();
  await expect(page.getByText(/probability/i)).toHaveCount(0);
  await expect(page.getByText("Depth ≥15 cm + heat top 10%")).toBeVisible();
});
