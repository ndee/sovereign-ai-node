import type { FastifyReply, FastifyRequest } from "fastify";

import { sendApiError } from "../response.js";
import type { Session, SessionStore } from "./sessions.js";

const ALLOW_PREFIXES = ["/setup-ui/"];
const ALLOW_GET_EXACT = new Set<string>(["/", "/healthz", "/api/auth/state"]);
const ALLOW_POST_EXACT = new Set<string>(["/api/auth/login"]);
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const isAllowed = (method: string, path: string): boolean => {
  if (ALLOW_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if ((method === "GET" || method === "HEAD") && ALLOW_GET_EXACT.has(path)) return true;
  if (method === "POST" && ALLOW_POST_EXACT.has(path)) return true;
  return false;
};

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export type AuthPreHandlerOptions = {
  sessions: SessionStore;
};

export const createAuthPreHandler = (options: AuthPreHandlerOptions) => {
  const { sessions } = options;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const [path] = request.url.split("?", 1) as [string];
    if (isAllowed(request.method, path)) {
      return;
    }

    const sid = request.cookies?.sov_session;
    const session = sessions.get(sid);
    if (session === null) {
      sendApiError(reply, 401, {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
        retryable: false,
      });
      return;
    }

    if (STATE_CHANGING_METHODS.has(request.method)) {
      const rawHeader = request.headers["x-csrf-token"];
      const csrfHeaderValue = typeof rawHeader === "string" ? rawHeader : undefined;
      const csrfCookie = request.cookies?.sov_csrf;
      if (
        csrfCookie === undefined ||
        csrfHeaderValue === undefined ||
        csrfCookie !== csrfHeaderValue ||
        csrfCookie !== session.csrf
      ) {
        sendApiError(reply, 403, {
          code: "CSRF_INVALID",
          message: "CSRF token missing or invalid",
          retryable: false,
        });
        return;
      }
    }

    request.session = session;
  };
};
