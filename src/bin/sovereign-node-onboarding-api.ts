#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

import {
  parseMatrixOnboardingState,
  redeemMatrixOnboardingCode,
  type MatrixOnboardingState,
} from "../onboarding/bootstrap-code.js";

const bindHost = process.env.SOVEREIGN_ONBOARDING_BIND_HOST ?? "0.0.0.0";
const bindPort = Number(process.env.SOVEREIGN_ONBOARDING_BIND_PORT ?? "8090");
const statePath = process.env.SOVEREIGN_ONBOARDING_STATE_PATH ?? "/onboarding/state.json";
const allowedSecretsDir = resolve(
  process.env.SOVEREIGN_ONBOARDING_ALLOWED_SECRETS_DIR ?? "/etc/sovereign-node/secrets",
);
const maxBodyBytes = 8 * 1024;

const sendJson = (
  response: import("node:http").ServerResponse,
  status: number,
  payload: unknown,
): void => {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(`${JSON.stringify(payload)}\n`);
};

const readState = async (): Promise<MatrixOnboardingState> => {
  const raw = await readFile(statePath, "utf8");
  const parsed = parseMatrixOnboardingState(JSON.parse(raw) as unknown);
  if (parsed === null) {
    throw new Error("Onboarding state file is invalid");
  }
  return parsed;
};

const writeState = async (state: MatrixOnboardingState): Promise<void> => {
  const tempPath = `${statePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
};

const resolveAllowedSecretPath = (secretRef: string): string => {
  if (!secretRef.startsWith("file:")) {
    throw new Error("Only file: secret refs are supported");
  }
  const target = resolve(secretRef.slice("file:".length));
  const prefix = `${allowedSecretsDir}/`;
  if (target !== allowedSecretsDir && !target.startsWith(prefix)) {
    throw new Error("Secret ref is outside the allowed secrets directory");
  }
  return target;
};

const readBody = async (
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> => new Promise((resolveBody, reject) => {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  request.on("data", (chunk: Buffer) => {
    totalLength += chunk.length;
    if (totalLength > maxBodyBytes) {
      reject(new Error("Request body too large"));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("error", reject);
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (raw.length === 0) {
      resolveBody({});
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        reject(new Error("Request body must be a JSON object"));
        return;
      }
      resolveBody(parsed as Record<string, unknown>);
    } catch (error) {
      reject(error);
    }
  });
});

const main = async (): Promise<void> => {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/redeem") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    try {
      const body = await readBody(request);
      const code = typeof body.code === "string" ? body.code : "";
      if (code.trim().length === 0) {
        sendJson(response, 400, {
          error: "invalid_request",
          message: "code is required",
        });
        return;
      }

      const state = await readState();
      const outcome = redeemMatrixOnboardingCode({ state, code });
      await writeState(outcome.state);
      if (!outcome.ok) {
        const status =
          outcome.reason === "consumed" ? 410
            : outcome.reason === "expired" ? 410
              : outcome.reason === "locked" ? 429
                : 401;
        sendJson(response, status, {
          error: outcome.reason,
          message:
            outcome.reason === "invalid"
              ? "The onboarding code is invalid"
              : outcome.reason === "locked"
                ? "The onboarding code is locked after too many failed attempts"
                : "The onboarding code is no longer available",
        });
        return;
      }

      const secretPath = resolveAllowedSecretPath(outcome.state.passwordSecretRef);
      const password = (await readFile(secretPath, "utf8")).trim();
      if (password.length === 0) {
        throw new Error("Resolved password secret file is empty");
      }

      sendJson(response, 200, {
        username: outcome.state.username,
        homeserverUrl: outcome.state.homeserverUrl,
        password,
      });
    } catch (error) {
      sendJson(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(bindPort, bindHost, () => {
    process.stdout.write(
      `sovereign-node-onboarding-api listening on ${bindHost}:${String(bindPort)} using ${dirname(statePath)}\n`,
    );
  });
};

main().catch((error) => {
  process.stderr.write(
    `sovereign-node-onboarding-api bootstrap failure: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
