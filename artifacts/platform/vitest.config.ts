import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    environment: "node",
    environmentMatchGlobs: [["src/lib/__tests__/pwaPushRepair.test.ts", "happy-dom"]],
  },
});
