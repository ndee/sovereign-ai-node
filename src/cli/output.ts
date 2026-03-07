import { randomUUID } from "node:crypto";

import type { ZodType } from "zod";

import {
  CONTRACT_VERSION,
  normalizeErrorDetail,
  type ErrorDetail,
} from "../contracts/common.js";
import {
  cliAnySuccessEnvelopeSchema,
  cliErrorEnvelopeSchema,
  cliLogEventSchema,
} from "../contracts/cli.js";

const now = () => new Date().toISOString();

export const writeCliSuccess = <T>(
  command: string,
  result: T,
  resultSchema: ZodType<T>,
  json: boolean,
): void => {
  if (!json) {
    process.stdout.write(`${command}: scaffold response generated\n`);
    return;
  }

  const envelope = cliAnySuccessEnvelopeSchema(resultSchema).parse({
    contractVersion: CONTRACT_VERSION,
    ok: true,
    command,
    timestamp: now(),
    requestId: `req_${randomUUID()}`,
    result,
  });

  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
};

export const writeCliError = (command: string, error: unknown, json: boolean): void => {
  const normalized: ErrorDetail = normalizeErrorDetail(error, "CLI_ERROR");

  if (!json) {
    process.stderr.write(`${command} failed: ${normalized.message}\n`);
    return;
  }

  const envelope = cliErrorEnvelopeSchema.parse({
    contractVersion: CONTRACT_VERSION,
    ok: false,
    command,
    timestamp: now(),
    requestId: `req_${randomUUID()}`,
    error: normalized,
  });
  process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
};

export const writeCliLogEvent = (event: unknown): void => {
  const parsed = cliLogEventSchema.parse(event);
  process.stdout.write(`${JSON.stringify(parsed)}\n`);
};
