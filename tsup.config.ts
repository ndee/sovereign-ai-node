import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      "sovereign-node": "src/bin/sovereign-node.ts",
      "sovereign-node-api": "src/bin/sovereign-node-api.ts",
      "sovereign-node-onboarding-api": "src/bin/sovereign-node-onboarding-api.ts",
      "sovereign-tool": "src/bin/sovereign-tool.ts",
    },
    outDir: "dist",
    format: "esm",
    dts: true,
    clean: true,
    target: "es2022",
  },
  {
    entry: {
      "lib/index": "src/lib/index.ts",
      "lib/installer": "src/lib/installer.ts",
      "lib/api": "src/lib/api.ts",
      "lib/system": "src/lib/system.ts",
      "lib/app": "src/lib/app.ts",
      "lib/contracts": "src/lib/contracts.ts",
    },
    outDir: "dist",
    format: "esm",
    dts: true,
    clean: false,
    target: "es2022",
  },
]);
