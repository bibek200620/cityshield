import { expect, test, type Page } from "@playwright/test";

const headers = { "access-control-allow-origin": "*" };
const source = { lat: 12.9762, lng: 77.5929 };
const destination = { lat: 12.9507, lng: 77.5848 };

async function installVoice(page: Page) {
  await page.addInitScript(({ lat, lng }) => {
    class Recognition {
      static active: Recognition | null = null;
      onstart?: () => void;
      onend?: () => void;
      onerror?: (event: { error: string }) => void;
      onresult?: (event: { resultIndex: number; results: unknown[] }) => void;
      start() {
        Recognition.active = this;
        setTimeout(() => this.onstart?.(), 0);
      }
      abort() {
        Recognition.active = null;
      }
    }
    window.addEventListener("cx-test-transcript", (event) => {
      const recognition = Recognition.active;
      if (!recognition) return;
      Recognition.active = null;
      const transcript = (event as CustomEvent<string>).detail;
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript } }] });
      recognition.onend?.();
    });
    window.addEventListener("cx-test-interim", () => {
      const recognition = Recognition.active;
      recognition?.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "What is the weather in Mysuru" } }] });
    });
    window.addEventListener("cx-test-denial", () => Recognition.active?.onerror?.({ error: "not-allowed" }));
    Object.defineProperty(window, "SpeechRecognition", { value: Recognition });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class {
      onend?: () => void;
      constructor(public text: string) {}
    } });
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [], cancel: () => {},
      speak: (utterance: { text: string; onend?: () => void }) => {
        document.body.dataset.spoken = utterance.text;
        setTimeout(() => utterance.onend?.(), 0);
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
  }, source);
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
  await expect(page.locator("body")).toHaveAttribute("data-spoken", /Finding a route from Majestic.*Lalbagh/);
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
  await say(page, "Option two");
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
