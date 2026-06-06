import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // index.ts: process bootstrap (main()); logger.ts/health.ts: thin I/O wired in
      // main(); types.ts: type-only declarations (no executable code).
      exclude: [
        "src/index.ts",
        "src/logger.ts",
        "src/health.ts",
        "src/tools/types.ts",
      ],
      thresholds: {
        // Trust-critical surfaces carry the highest bar (measured ~99% / ~90%).
        "src/vault/**": { lines: 95, functions: 95, branches: 88 },
        "src/tools/**": { lines: 85, functions: 80, branches: 85 },
        // Global floor (measured ~89%).
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
