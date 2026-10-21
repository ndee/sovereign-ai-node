#!/usr/bin/env node
// CLI entry for the root-owned reclaim-ownership helper.
// Logic lives in ../privileged-reclaim-ownership.mjs.

import { loadHelperConfig, runHelper } from "../privileged-helper-config.mjs";
import { reclaimOwnership } from "../privileged-reclaim-ownership.mjs";

process.exitCode = await runHelper(
  () => reclaimOwnership({ argv: process.argv.slice(2), identity: loadHelperConfig() }),
  { name: "reclaim-ownership" },
);
