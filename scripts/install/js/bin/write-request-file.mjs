#!/usr/bin/env node
// CLI entry: synthesise the install request JSON from SN_* env vars.
// Pure logic lives in ../write-request-file.mjs.

import { runCli } from "../write-request-file.mjs";

runCli();
