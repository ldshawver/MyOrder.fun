import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: "pnpm run build && PORT=4173 pnpm exec vite preview --config vite.config.ts --host 127.0.0.1",
    url: "http://127.0.0.1:4173/catalog",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "auth", testMatch: /auth\.setup\.ts/ },
    { name: "chromium", dependencies: ["auth"], testIgnore: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", dependencies: ["auth"], testIgnore: /auth\.setup\.ts/, use: { ...devices["Pixel 5"] } },
  ],
});
