#!/usr/bin/env node
// CLI entry for the root-owned bundled-matrix-docker helper.
// Logic lives in ../privileged-bundled-matrix-docker.mjs.

import { runBundledMatrixDocker } from "../privileged-bundled-matrix-docker.mjs";
import { loadHelperConfig, runHelper } from "../privileged-helper-config.mjs";

process.exitCode = await runHelper(
  () => runBundledMatrixDocker({ argv: process.argv.slice(2), identity: loadHelperConfig() }),
  { name: "bundled-matrix-docker" },
);
