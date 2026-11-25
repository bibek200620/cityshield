import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "list",
  retries: process.env.CI ? 1 : 0,
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    headless: true,
    launchOptions: { args: ["--use-gl=swiftshader", "--enable-webgl"] },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
