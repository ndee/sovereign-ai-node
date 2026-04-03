import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/api/**/*.test.ts", "src/cli/**/*.test.ts", "src/installer/**/*.test.ts"],
    coverage: {
      provider: "v8",
      enabled: true,
      all: true,
      reportsDirectory: "coverage/integration",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: ["src/api/**/*.ts", "src/cli/**/*.ts", "src/installer/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        statements: 59,
        branches: 66,
        functions: 82,
        lines: 59,
      },
    },
  },
});
