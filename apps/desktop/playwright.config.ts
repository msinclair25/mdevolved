import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 10_000 },
  outputDir: "../../test-results/desktop-playwright",
  reporter: process.env.CI ? "line" : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "e2e",
  timeout: 45_000,
  workers: 1,
});
