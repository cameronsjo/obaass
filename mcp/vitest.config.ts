import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // index.ts is the process bootstrap (wired in main()); logger.ts is trivial I/O.
      exclude: ["src/index.ts", "src/logger.ts", "src/health.ts"],
      thresholds: {
        // Trust-critical surfaces carry the highest bar.
        "src/vault/**": { lines: 80, functions: 80, branches: 70 },
        "src/tools/**": { lines: 80, functions: 80, branches: 70 },
        // Global floor.
        lines: 60,
        functions: 60,
        branches: 55,
      },
    },
  },
});
