import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // The host reports many CPUs but cannot reliably start that many forks.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
  },
});
