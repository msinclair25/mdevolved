import { defineConfig, devices } from "@playwright/test";

const e2ePort = process.env.OWD_E2E_PORT ?? "4173";
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: false,
  outputDir: "test-results/playwright",
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  retries: process.env.CI ? 1 : 0,
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: e2eBaseUrl,
    channel: "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `pnpm --filter @owd/web dev --host 127.0.0.1 --port ${e2ePort}`,
    reuseExistingServer: !process.env.CI,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 120_000,
    url: e2eBaseUrl,
  },
  projects: [
    {
      name: "chrome-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chrome-narrow",
      use: {
        ...devices["Desktop Chrome"],
        hasTouch: true,
        viewport: { height: 800, width: 360 },
      },
    },
  ],
});
