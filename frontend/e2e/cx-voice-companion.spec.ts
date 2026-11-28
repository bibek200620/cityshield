import { expect, test, type Page } from "@playwright/test";

const headers = { "access-control-allow-origin": "*" };
const source = { lat: 12.9762, lng: 77.5929 };
const destination = { lat: 12.9507, lng: 77.5848 };

async function installVoice(page: Page, holdSpeech = "") {
  await page.addInitScript(({ lat, lng, holdSpeech }) => {
    class Recognition {
      static active: Recognition | null = null;
      onstart?: () => void;
      onend?: () => void;
      onerror?: (event: { error: string }) => void;
      onresult?: (event: { resultIndex: number; results: unknown[] }) => void;
      start() {
        Recognition.active = this;
        document.body.dataset.recognizer = "active";
        setTimeout(() => this.onstart?.(), 0);
      }
      abort() {
        Recognition.active = null;
        delete document.body.dataset.recognizer;
      }
    }
    window.addEventListener("cx-test-transcript", (event) => {
      const recognition = Recognition.active;
      if (!recognition) return;
      Recognition.active = null;
      delete document.body.dataset.recognizer;
      const detail = (event as CustomEvent<string | string[]>).detail;
      const transcripts = Array.isArray(detail) ? detail : [detail];
      recognition.onresult?.({ resultIndex: 0, results: [{
        isFinal: true, length: transcripts.length,
        ...Object.fromEntries(transcripts.map((transcript, index) => [index, { transcript }])),
      }] });
      recognition.onend?.();
    });
    window.addEventListener("cx-test-interim", (event) => {
      const recognition = Recognition.active;
      const transcript = (event as CustomEvent<string>).detail ?? "What is the weather in Mysuru";
      recognition?.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript } }] });
    });
    window.addEventListener("cx-test-segments", (event) => {
      const segments = (event as CustomEvent<Array<{ transcript: string; isFinal: boolean }>>).detail;
      Recognition.active?.onresult?.({ resultIndex: segments.length - 1, results: segments.map(({ transcript, isFinal }) => ({
        isFinal, 0: { transcript },
      })) });
    });
    window.addEventListener("cx-test-denial", () => Recognition.active?.onerror?.({ error: "not-allowed" }));
    Object.defineProperty(window, "SpeechRecognition", { value: Recognition });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class {
      onend?: () => void;
      constructor(public text: string) {}
    } });
    let held: { text: string; onend?: () => void } | null = null;
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [],
      cancel: () => {
        if (!held) return;
        const cancelled = held;
        held = null;
        document.body.dataset.cancelledSpeech = cancelled.text;
        setTimeout(() => cancelled.onend?.(), 0);
      },
      speak: (utterance: { text: string; onend?: () => void }) => {
        document.body.dataset.spoken = utterance.text;
        if (holdSpeech && utterance.text.startsWith(holdSpeech)) held = utterance;
        else setTimeout(() => utterance.onend?.(), 0);
      },
    } });
    function location(latitude: number, longitude: number) {
      return { coords: { latitude, longitude, accuracy: 8, heading: null, speed: null }, timestamp: Date.now() };
    }
    let updateGps: EventListener | undefined;
    Object.defineProperty(navigator, "geolocation", { value: {
      watchPosition: (onLocation: (position: unknown) => void) => {
        document.body.dataset.gps = "active";
        setTimeout(() => onLocation(location(lat, lng)), 0);
        updateGps = (event) => {
          const point = (event as CustomEvent<{ lat: number; lng: number }>).detail;
          onLocation(location(point.lat, point.lng));
        };
        window.addEventListener("cx-test-gps", updateGps);
        return 1;
      },
      clearWatch: () => {
        document.body.dataset.gps = "stopped";
        if (updateGps) window.removeEventListener("cx-test-gps", updateGps);
      },
    } });
  }, { ...source, holdSpeech });
  await page.route("**/api/assistant/outlook", (route) => route.fulfill({ json: { status: "unavailable" }, headers }));
  await page.goto("/");
  const cx = page.getByRole("button", { name: "CX assistant", exact: true });
  await expect(page.getByRole("button", { name: "Stop listening" })).toHaveCount(0);
  await cx.click();
  await page.getByRole("button", { name: "Start talking" }).click();
  await expect(page.locator(".voice-session-hint")).toContainText(/hello cx/i);
}

async function say(page: Page, text: string) {
  await expect(page.locator(".voice-session-hint")).toContainText(/Listening|hello cx/i);
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("cx-test-transcript", { detail })), text);
}

test("CX interrupts speech on C X and keeps the weather context for the follow-up", async ({ page }) => {
  const now = new Date();
  await page.route("**/api/weather/nowcast*", (route) => route.fulfill({ headers, json: {
    status: "ready", air_temperature_c: 25, feels_like_c: 26, recent_rain_mm: 0, upcoming_rain_mm: 0,
    valid_at: now.toISOString(),
    hourly_forecast: [1, 2, 3].map((hour) => ({
      valid_at: new Date(now.getTime() + hour * 3600_000).toISOString(),
      air_temperature_c: 25, feels_like_c: 26, precipitation_mm: 0, relative_humidity_pct: 40,
    })),
    provenance: { retrieved_at: now.toISOString(), grid_cell_center: { latitude: 12.98, longitude: 77.59 } },
  } }));
  await installVoice(page, "Right now");
  await say(page, "Hello CX, weather now");
  const body = page.locator("body");
  await expect(body).toHaveAttribute("data-spoken", /^Right now/);
  await expect(body).toHaveAttribute("data-recognizer", "active");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cx-test-interim", { detail: "C X" })));
  await expect(body).toHaveAttribute("data-cancelled-speech", /^Right now/);
  await expect(page.locator(".voice-response")).toHaveText("Go ahead with your follow-up.");
  await say(page, "C X, and for the next two hours?");
  await expect(body).toHaveAttribute("data-spoken", /next 2 hours/);
  await expect(page.getByRole("button", { name: "Stop listening" })).toBeVisible();
});

test("CX accepts C X alone while working and ignores the superseded response", async ({ page }) => {
  let releaseResponse!: () => void;
  const delay = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let requested = false;
  await page.route("**/api/assistant/conversation", async (route) => {
    requested = true;
    await delay;
    await route.fulfill({ headers, json: { status: "ready", reply: "This old answer should stay silent." } }).catch(() => {});
  });
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await installVoice(page);
  await say(page, "Hello CX, how does the atlas work?");
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator(".voice-session-hint")).toContainText("Working");
  await expect(page.locator("body")).toHaveAttribute("data-recognizer", "active");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cx-test-transcript", { detail: "C X" })));
  await expect(page.locator(".voice-session-hint")).toContainText("Listening for your follow-up");
  releaseResponse();
  await say(page, "Toggle heat");
  await expect(page.getByRole("checkbox", { name: "Heat", exact: true })).toBeChecked();
  await expect(page.locator(".voice-response")).toHaveText("The heat layer is on.");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", "The heat layer is on.");
});

test("CX pans the actual map and runs a custom rainfall scenario by command", async ({ page }) => {
  await page.route("https://basemaps.cartocdn.com/**", (route) =>
    route.fulfill({ json: { version: 8, layers: [], sources: {} } }));
  await page.route("**/api/places/search?*", (route) => route.fulfill({ headers, json: { status: "ready", results: [
    { id: "bengaluru", name: "Bengaluru, Karnataka", ...source },
  ] } }));
  let simulation: unknown;
  let presetsUsed = 0;
  await page.route("http://localhost:8000/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/scenarios") return route.fulfill({ headers, json: [{
      scenario_id: "saved-moderate", label: "Moderate storm", rainfall_intensity_mm_hr: 60, duration_min: 90,
    }] });
    if (path === "/api/scenarios/saved-moderate") {
      presetsUsed++;
      return route.fulfill({ headers, json: { scenario_id: "saved-moderate", node_predictions: [], road_segments: [] } });
    }
    if (path === "/api/simulate") {
      simulation = route.request().postDataJSON();
      return route.fulfill({ headers, json: { scenario_id: "custom", node_predictions: [], road_segments: [] } });
    }
    if (path === "/api/places/search") return route.fallback();
    return route.fulfill({ headers, json: path === "/api/critical-infrastructure"
      ? [] : { status: "unavailable" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "CX assistant", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Type a request" });
  const answer = page.locator(".voice-response");
  async function command(text: string, expected: string | RegExp) {
    await input.fill(text);
    await input.press("Enter");
    await expect(answer).toContainText(expected);
  }
  await command("Find Bengaluru", "Showing Bengaluru");
  const marker = page.locator(".place-marker");
  await expect(marker).toBeVisible();
  const initialX = (await marker.boundingBox())!.x;
  await command("Pan east", "Panned the map east.");
  await expect.poll(async () => (await marker.boundingBox())!.x).toBeLessThan(initialX - 25);
  await command("Zoom in two levels", "Zoomed in 2 levels.");
  await command("I’d like you to show me the heat layer on the map, please.", "The heat layer is on.");
  await expect(page.getByRole("checkbox", { name: "Heat", exact: true })).toBeChecked();
  await command("Toggle heat layer", "The heat layer is off.");
  await command("Run a moderate storm", /90 millimetres over 90 minutes/);
  expect(presetsUsed).toBe(1);
  await command("Could you please simulate seventy-five millimetres per hour for two hours?", /150 millimetres over 120 minutes/);
  expect(simulation).toEqual({ rainfall_intensity_mm_hr: 75, duration_min: 120 });
  await command("Simulate 999 mm/hr for 1 hour", /5 to 150 millimetres per hour/);
  expect(simulation).toEqual({ rainfall_intensity_mm_hr: 75, duration_min: 120 });
});

test("CX recovers a wake phrase and a map command from speech alternatives", async ({ page }) => {
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await installVoice(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cx-test-transcript", {
    detail: ["Hello eggs show road flood risk", "Hello CX, show road flood risk"],
  })));
  await expect(page.getByRole("checkbox", { name: "Road flood risk", exact: true })).toBeChecked();
  await expect(page.locator(".voice-response")).toHaveText("The road flood risk layer is on.");
  await expect(page.locator(".voice-transcript")).toContainText("Hello CX");
  await expect(page.locator("body")).not.toHaveAttribute("data-gps");
});

test("CX waits for the complete spoken sentence and then pans to the named place", async ({ page }) => {
  await page.route("https://basemaps.cartocdn.com/**", (route) =>
    route.fulfill({ json: { version: 8, layers: [], sources: {} } }));
  const queries: string[] = [];
  await page.route("**/api/places/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("query") ?? "";
    queries.push(query);
    const place = query === "Lalbagh" ? { id: "lalbagh", name: "Lalbagh, Bengaluru", ...destination }
      : { id: "mysuru", name: "Mysuru, Karnataka", lat: 12.2958, lng: 76.6394 };
    const results = query === "Mysuru" ? [place, { ...place, id: "mysuru-boundary", lat: place.lat + 0.002 }] : [place];
    return route.fulfill({ headers, json: { status: "ready", results } });
  });
  await installVoice(page);
  const firstSegment = { transcript: "Hello, CX, could you move the map.", isFinal: true };
  async function emit(segments: Array<{ transcript: string; isFinal: boolean }>) {
    await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("cx-test-segments", { detail })), segments);
  }
  await emit([firstSegment]);
  await emit([firstSegment, { transcript: "over to Lal", isFinal: false }]);
  await expect(page.locator(".voice-transcript")).toContainText("over to Lal");
  expect(queries).toEqual([]);
  await emit([firstSegment, { transcript: "over to Lalbagh, please?", isFinal: true }]);
  await expect(page.locator(".voice-response")).toHaveText("Showing Lalbagh, Bengaluru on the map.");
  await expect(page.locator(".place-marker")).toBeVisible();
  await say(page, "What about Mysuru?");
  await expect(page.locator(".voice-response")).toHaveText("Showing Mysuru, Karnataka on the map.");
  expect(queries).toEqual(["Lalbagh", "Mysuru"]);
  await expect(page.locator("body")).not.toHaveAttribute("data-gps");
});

test("CX asks before using a misheard place alternative and accepts clarification by city", async ({ page }) => {
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await page.route("**/api/places/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("query")?.toLowerCase();
    const lalbagh = { id: "lalbagh", name: "Lalbagh, Bengaluru", ...destination };
    const other = { id: "lalbagh-mangaluru", name: "Lalbagh, Mangaluru", lat: 12.883, lng: 74.841 };
    const results = query === "lalbagh garden" ? [lalbagh] : query === "lalbagh" ? [lalbagh, other] : [];
    return route.fulfill({ headers, json: { status: "ready", results } });
  });
  await installVoice(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cx-test-transcript", {
    detail: ["Hello CX, could you center the map on Lull Bug Garden?", "Hello CX, could you center the map on Lalbagh Garden?"],
  })));
  await expect(page.locator(".voice-response")).toHaveText("Did you mean Lalbagh, Bengaluru? Reply yes or cancel.");
  await expect(page.locator(".place-marker")).toHaveCount(0);
  await say(page, "Yes, please.");
  await expect(page.locator(".voice-response")).toHaveText("Showing Lalbagh, Bengaluru on the map.");
  await say(page, "Would you mind centering the map on Lalbagh?");
  await expect(page.getByRole("button", { name: "Lalbagh, Mangaluru", exact: true })).toBeVisible();
  await say(page, "The one in Mangaluru, please.");
  await expect(page.locator(".voice-response")).toHaveText("Showing Lalbagh, Mangaluru on the map.");
  await expect(page.locator("body")).not.toHaveAttribute("data-gps");
});

test("CX can still pan to a named city when online place search is unavailable", async ({ page }) => {
  await page.route("https://basemaps.cartocdn.com/**", (route) =>
    route.fulfill({ json: { version: 8, layers: [], sources: {} } }));
  await page.route("**/api/places/search?*", (route) => route.fulfill({
    status: 503, headers, json: { detail: "Place search is temporarily unavailable." },
  }));
  await installVoice(page);
  await say(page, "Hello CX, would you mind centering the map on Mysuru in Karnataka?");
  await expect(page.locator(".voice-response")).toHaveText("Showing Mysuru, Karnataka on the map.");
  await expect(page.locator(".place-marker")).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("data-gps");
});

test("CX executes validated site actions from full requests it sends to conversation mode", async ({ page }) => {
  const turns: unknown[] = [];
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await page.route("**/api/assistant/conversation", (route) => {
    const turn = route.request().postDataJSON();
    turns.push(turn);
    const action = turns.length === 1 ? { kind: "show-place", query: "Lalbagh" } : { kind: "layer", layer: "heat", enabled: true };
    return route.fulfill({ headers, json: { status: "ready", reply: "I’ll check that for you.", action } });
  });
  await page.route("**/api/places/search?*", (route) => route.fulfill({ headers, json: { status: "ready", results: [
    { id: "lalbagh", name: "Lalbagh, Bengaluru", ...destination },
  ] } }));
  await installVoice(page);
  await say(page, "Hello CX, I would love a closer look at Lalbagh. Could you frame that area for me?");
  await expect(page.locator(".voice-response")).toHaveText("Showing Lalbagh, Bengaluru on the map.");
  await say(page, "Keep the focus there, and make the heat overlay visible for me.");
  await expect(page.getByRole("checkbox", { name: "Heat", exact: true })).toBeChecked();
  await expect(page.locator(".voice-response")).toHaveText("The heat layer is on.");
  expect(turns[1]).toMatchObject({ history: [
    { role: "user", text: expect.stringContaining("Lalbagh") },
    { role: "assistant", text: "Showing Lalbagh, Bengaluru on the map." },
  ] });
  await expect(page.locator("body")).not.toHaveAttribute("data-gps");
});

test("CX can run and stop a rainfall demo by keyboard with voice unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "SpeechRecognition", { value: undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined });
  });
  await page.route("https://basemaps.cartocdn.com/**", (route) => route.abort());
  await page.route("http://localhost:8000/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (["/api/scenarios", "/api/critical-infrastructure"].includes(path)) return route.fulfill({ json: [], headers });
    if (path === "/api/simulate") {
      return route.fulfill({ headers, json: {
        scenario_id: "cx-demo", node_predictions: [], road_segments: [], at_risk_infra_ids: [],
      } });
    }
    return route.fulfill({ json: { status: "unavailable" }, headers });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "CX assistant", exact: true }).press("Enter");
  const entry = page.getByRole("textbox", { name: "Type a request" });
  const answer = page.locator(".voice-response");
  await entry.fill("Could you open the scenarios tab, please?");
  await entry.press("Enter");
  await expect(page.getByRole("heading", { name: "Rainfall scenario" })).toBeFocused();
  await expect(answer).toHaveText("Opened rainfall scenario.");
  await entry.fill("Run flood demo");
  await entry.press("Enter");
  await expect(answer).toContainText("The Bengaluru flood demo is running");
  await expect(page.getByRole("checkbox", { name: "Road flood risk", exact: true })).toBeChecked();
  await entry.fill("Stop simulation");
  await entry.press("Enter");
  await expect(answer).toHaveText("Stopped the rainfall simulation.");
  await expect(page.getByText("Road flood risk · next 3 hours")).toBeVisible();
});

test("CX wakes on request, speaks conversational replies, and clears context on standby", async ({ page }) => {
  const requests: unknown[] = [];
  let placeSearches = 0;
  await page.route("**/api/places/search?*", (route) => {
    placeSearches++;
    return route.fulfill({ headers, json: { status: "ready", results: [] } });
  });
  await page.route("**/api/assistant/conversation", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ headers, json: { status: "ready", reply: "Navigate to Lalbagh." } });
  });
  await installVoice(page);
  const body = page.locator("body");
  await say(page, "Navigate to Lalbagh");
  await expect(page.locator(".voice-session-hint")).toContainText(/Starting|hello cx/i);
  expect(placeSearches).toBe(0);

  await say(page, "Hello CX");
  await expect(body).toHaveAttribute("data-spoken", /I’m here/);
  await say(page, "How are you?");
  await expect(body).toHaveAttribute("data-spoken", /Ready when you are/);
  await say(page, "Tell me a joke");
  await expect(body).toHaveAttribute("data-spoken", "Navigate to Lalbagh.");
  await say(page, "Tell me another");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests).toEqual([
    { message: "Tell me a joke", history: [] },
    { message: "Tell me another", history: [
      { role: "user", text: "Tell me a joke" },
      { role: "assistant", text: "Navigate to Lalbagh." },
    ] },
  ]);
  expect(placeSearches).toBe(0);
  await expect(body).not.toHaveAttribute("data-gps");
  await expect(page.getByText("Tell me a joke", { exact: true })).toHaveCount(0);

  await say(page, "Go to sleep");
  await expect(body).toHaveAttribute("data-spoken", /Standing by/);
  await expect(page.locator(".voice-session-hint")).toContainText(/hello cx/i);
  await say(page, "CX agent, tell me a story");
  await expect.poll(() => requests[2]).toEqual({ message: "tell me a story", history: [] });
  await expect(body).toHaveAttribute("data-spoken", "Navigate to Lalbagh.");
});

test("CX shows a live transcript and makes the next action clear", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await installVoice(page);
  const indicator = page.getByRole("button", { name: "Stop listening" });
  await expect(indicator).toBeVisible();
  await expect(page.locator(".mascot-bubble")).toBeInViewport();
  await page.evaluate(() => window.dispatchEvent(new Event("cx-test-interim")));
  await expect(page.locator(".voice-transcript")).toContainText("What is the weather in Mysuru");
  await expect(page.locator(".voice-session-hint")).toContainText(/hello cx/i);
  await say(page, "Hello CX");
  await expect(page.locator(".voice-transcript")).toContainText("Hello CX");
  await expect(page.locator(".mascot-voice-help")).toContainText("browser may process microphone audio online");
  await expect(page.getByRole("button", { name: "Stop listening" })).toBeVisible();
});

test("closing CX ends the microphone session", async ({ page }) => {
  await installVoice(page);
  await expect(page.getByRole("button", { name: "Stop listening" })).toBeVisible();
  await page.getByRole("button", { name: "Close CX bubble" }).click();
  await expect(page.getByRole("button", { name: "Stop listening" })).toHaveCount(0);
  await expect(page.locator("#mascot-bubble")).toHaveCount(0);
  await page.getByRole("button", { name: "CX assistant", exact: true }).click();
  const talk = page.getByRole("button", { name: "Start talking" });
  await expect(talk).toBeVisible();
  await talk.focus();
  await talk.press("Enter");
  await expect(page.getByRole("button", { name: "Stop listening" })).toBeVisible();
});

test("CX returns to the wake phrase after conversation inactivity", async ({ page }) => {
  await page.clock.install();
  await installVoice(page);
  await say(page, "CX agent");
  await expect(page.locator(".voice-session-hint")).toContainText("Listening");
  await page.clock.fastForward(46_000);
  await expect(page.locator(".voice-session-hint")).toContainText(/hello cx/i);
  await say(page, "Stop listening");
  await expect(page.getByRole("button", { name: "Stop listening" })).toHaveCount(0);
});

test("CX plans between named places and starts GPS for an explicit current-location route", async ({ page }) => {
  const plannedOrigin = { lat: 12.978, lng: 77.570 };
  const requests: unknown[] = [];
  await page.route("**/api/places/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("query")?.toLowerCase();
    const place = query === "majestic" ? { id: "origin", name: "Majestic, Bengaluru", ...plannedOrigin }
      : query === "lalbagh" ? { id: "destination", name: "Lalbagh Botanical Garden, Bengaluru", ...destination } : null;
    return route.fulfill({ headers, json: { status: "ready", results: place ? [place] : [] } });
  });
  await page.route("**/api/drive/routes", (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    return route.fulfill({ headers, json: {
      source: "FOSSGIS Valhalla · OpenStreetMap", shortest_available: false, traffic: { status: "unavailable" },
      weather: { status: "unavailable" }, runoff_available: false, flood_reports: { status: "unavailable" },
      routes: [{
        id: "0", labels: ["Best estimated time"], eta_seconds: 600, distance_km: 3,
        coordinates: [[request.source.lng, request.source.lat], [destination.lng, destination.lat]],
      }],
    } });
  });
  await page.route("**/api/assistant/conversation", (route) => {
    const message = route.request().postDataJSON().message as string;
    const action = message.toLowerCase().includes("current")
      ? { kind: "route", source: "my current place", destination: "Lalbagh" }
      : { kind: "route", source: "Majestic", destination: "Lalbagh" };
    return route.fulfill({ headers, json: { status: "ready", reply: "I’ll check that for you.", action } });
  });
  await installVoice(page);
  await say(page, "CX agent, can you set a route from Majestic to Lalbagh?");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /Route ready from Majestic.*Lalbagh/);
  expect(requests[0]).toMatchObject({ source: plannedOrigin, destination });
  await expect(page.locator("body")).not.toHaveAttribute("data-gps");

  await say(page, "Can you create a route from my current place to Lalbagh?");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /Navigation started/);
  expect(requests[1]).toMatchObject({ source, destination });
  await expect(page.getByRole("img", { name: "Your current GPS location" })).toBeVisible();
});

test("CX interprets a full turn before handling a follow-up with forecast data", async ({ page }) => {
  const requests: unknown[] = [];
  let nowcasts = 0;
  await page.route("**/api/assistant/conversation", (route) => {
    requests.push(route.request().postDataJSON());
    const json = { status: "ready", reply: "The map shows model estimates for Bengaluru." };
    return route.fulfill({ headers, json });
  });
  await page.route("**/api/weather/nowcast", (route) => {
    nowcasts++;
    const time = new Date().toISOString();
    return route.fulfill({ headers, json: {
      status: "ready", source: "Open-Meteo", air_temperature_c: 25, feels_like_c: 27, weather_code: 3, hourly_forecast: [],
      valid_at: time, upcoming_rain_mm: 0, recent_rain_mm: 0,
      provenance: { retrieved_at: time, grid_cell_center: { latitude: 12.98, longitude: 77.59 } },
    } });
  });
  await installVoice(page);
  const initialNowcasts = nowcasts;
  await say(page, "Hello CX, how does the map use the weather forecast?");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", "The map shows model estimates for Bengaluru.");
  expect(nowcasts).toBe(initialNowcasts);
  await say(page, "And tomorrow?");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ message: "And tomorrow?" });
  expect(requests[1]).toMatchObject({ history: [
    { role: "user", text: "how does the map use the weather forecast?" },
    { role: "assistant", text: "The map shows model estimates for Bengaluru." },
  ] });
});

test("CX speaks current weather and a requested forecast duration without a transcript", async ({ page }) => {
  await page.clock.setFixedTime(new Date(Date.UTC(2026, 10, 27, 23, 59)));
  const hours = Array.from({ length: 48 }, (_, index) => ({
    valid_at: new Date(Date.UTC(2026, 10, 28, index)).toISOString(),
    air_temperature_c: 22 + index, feels_like_c: 23 + index, relative_humidity_pct: 70, precipitation_mm: 1,
  }));
  await page.route("**/api/weather/nowcast*", (route) => route.fulfill({ headers, json: {
    status: "ready", source: "Open-Meteo", air_temperature_c: 25, feels_like_c: 27, weather_code: 3, hourly_forecast: hours.slice(0, 3),
    valid_at: hours[0].valid_at, upcoming_rain_mm: 3, recent_rain_mm: 0,
    provenance: { retrieved_at: hours[0].valid_at, grid_cell_center: { latitude: 12.98, longitude: 77.59 } },
  } }));
  await page.route("**/api/weather/report*", (route) => route.fulfill({ headers, json: {
    status: "ready", source: "Open-Meteo", forecast_hours: 48, hourly_forecast: hours,
  } }));
  await installVoice(page);
  await say(page, "Hey C X, what's the weather now?");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /25 degrees Celsius.*overcast/);
  await expect(page.locator(".voice-transcript")).toContainText("what's the weather now?");
  await say(page, "And for the next six hours?");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /next 6 hours.*22 and 27.*6 millimetres/);
  await say(page, "What is the forecast for the next three days?");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /forecast up to 48 hours/);
  await say(page, "Stop listening");
  await expect(page.getByRole("button", { name: "Stop listening" })).toHaveCount(0);
});

test("CX confirms ambiguous places before starting GPS navigation and reads provider instructions", async ({ page }) => {
  let routeCalls = 0;
  await page.route("**/api/places/search?*", (route) => route.fulfill({ headers, json: { status: "ready", results: [
    { id: "one", name: "Lalbagh station, Bengaluru", category: "station", lat: 12.944, lng: 77.579 },
    { id: "two", name: "Lalbagh Botanical Garden, Bengaluru", category: "park", ...destination },
  ] } }));
  await page.route("**/api/drive/routes", (route) => {
    routeCalls++;
    const request = route.request().postDataJSON();
    expect(request.source).toMatchObject(source);
    expect(request.destination).toMatchObject(destination);
    return route.fulfill({ headers, json: {
      source: "FOSSGIS Valhalla · OpenStreetMap", shortest_available: false, traffic: { status: "unavailable" },
      weather: { status: "unavailable" }, runoff_available: false, flood_reports: { status: "unavailable" },
      routes: [{
        id: "0", labels: ["Best estimated time"], eta_seconds: 600, distance_km: 3,
        coordinates: [[source.lng, source.lat], [77.59, 12.966], [destination.lng, destination.lat]],
        guidance: [{ point_index: 1, instruction: "Turn left onto the main road." }],
      }],
    } });
  });
  await installVoice(page);
  await say(page, "CX agent, navigate to Lalbagh");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /Option 2, Lalbagh Botanical Garden/);
  await say(page, "Yes");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /Say an option number/);
  expect(routeCalls).toBe(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-gps");
  await page.getByRole("group", { name: "Confirm a place" }).getByRole("button", { name: "Lalbagh Botanical Garden, Bengaluru" }).press("Enter");
  await expect(page.getByRole("button", { name: "Stop listening" })).toBeFocused();
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /Navigation started.*10 minutes/);
  await expect(page.getByRole("img", { name: "Your current GPS location" })).toBeVisible();
  await say(page, "What's the next turn?");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /Turn left onto the main road/);
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("cx-test-gps", { detail })), {
    lat: source.lat + (12.966 - source.lat) * .96,
    lng: source.lng + (77.59 - source.lng) * .96,
  });
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /about 50 metres\. Turn left onto the main road/);
  await say(page, "Stop navigation");
  await expect(page.locator("body")).toHaveAttribute("data-spoken", "Navigation stopped.");
  await expect(page.locator("body")).toHaveAttribute("data-gps", "stopped");
  expect(routeCalls).toBe(1);
});

test("CX stops recognition and explains denied microphone access", async ({ page }) => {
  await installVoice(page);
  await page.evaluate(() => window.dispatchEvent(new Event("cx-test-denial")));
  await expect(page.getByRole("button", { name: "Stop listening" })).toHaveCount(0);
  await expect(page.getByText("Allow microphone access in your browser to talk to CX.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try voice again" })).toBeVisible();
});
