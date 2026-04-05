import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/app/**/*.test.ts",
      "src/bots/**/*.test.ts",
      "src/config/**/*.test.ts",
      "src/contracts/**/*.test.ts",
      "src/logging/**/*.test.ts",
      "src/onboarding/**/*.test.ts",
      "src/openclaw/**/*.test.ts",
      "src/system/**/*.test.ts",
      "src/tooling/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      enabled: true,
      all: true,
      reportsDirectory: "coverage/unit",
      reporter: ["text-summary", "json-summary", "lcov"],
      include: [
        "src/app/**/*.ts",
        "src/bots/**/*.ts",
        "src/config/**/*.ts",
        "src/contracts/**/*.ts",
        "src/logging/**/*.ts",
        "src/onboarding/**/*.ts",
        "src/openclaw/**/*.ts",
        "src/system/**/*.ts",
        "src/tooling/**/*.ts",
      ],
      exclude: ["**/*.test.ts"],
      thresholds: {
        statements: 68,
        branches: 66,
        functions: 87,
        lines: 68,
      },
    },
  },
});
