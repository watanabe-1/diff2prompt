/// <reference types="vitest" />

import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json", "json-summary"],
      reportOnFailure: true,
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/**/index.ts",
        "src/**/types.ts",
        "src/**/*-types.ts",
      ],
    },
  },
});
