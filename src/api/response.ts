import { randomUUID } from "node:crypto";

import type { FastifyReply } from "fastify";
import type { ZodType } from "zod";

import { CONTRACT_VERSION, type ErrorDetail } from "../contracts/common.js";
import { baseSuccessEnvelopeSchema } from "../contracts/common.js";

const now = () => new Date().toISOString();

export const sendApiSuccess = <T>(
  reply: FastifyReply,
  result: T,
  resultSchema: ZodType<T>,
): FastifyReply => {
  const payload = baseSuccessEnvelopeSchema(resultSchema).parse({
    contractVersion: CONTRACT_VERSION,
    ok: true,
    timestamp: now(),
    requestId: `req_${randomUUID()}`,
    result,
  });
  return reply.send(payload);
};

export const sendApiError = (
  reply: FastifyReply,
  statusCode: number,
  error: unknown,
): FastifyReply => {
  const normalized: ErrorDetail = {
    code: "API_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };

  return reply.code(statusCode).send({
    contractVersion: CONTRACT_VERSION,
    ok: false,
    timestamp: now(),
    requestId: `req_${randomUUID()}`,
    error: normalized,
  });
};

