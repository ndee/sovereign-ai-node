import { randomUUID } from "node:crypto";

import type { FastifyReply } from "fastify";
import type { ZodType } from "zod";
import {
  baseSuccessEnvelopeSchema,
  CONTRACT_VERSION,
  type ErrorDetail,
  normalizeErrorDetail,
} from "../contracts/common.js";

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
  const normalized: ErrorDetail = normalizeErrorDetail(error, "API_ERROR");

  return reply.code(statusCode).send({
    contractVersion: CONTRACT_VERSION,
    ok: false,
    timestamp: now(),
    requestId: `req_${randomUUID()}`,
    error: normalized,
  });
};
