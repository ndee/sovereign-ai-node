#!/usr/bin/env node
// CLI entry for the root-owned install-systemd-unit helper.
// Logic lives in ../privileged-systemd-unit.mjs.

import { readFileSync } from "node:fs";

import { loadHelperConfig, runHelper } from "../privileged-helper-config.mjs";
import { installSystemdUnit } from "../privileged-systemd-unit.mjs";

process.exitCode = await runHelper(
  () => {
    installSystemdUnit({
      argv: process.argv.slice(2),
      stdinText: readFileSync(0, "utf8"),
      identity: loadHelperConfig(),
    });
    return 0;
  },
  { name: "install-systemd-unit" },
);
