import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AppContainer } from "../../app/create-app.js";
import {
  authLoginRequestSchema,
  authLoginResponseSchema,
  authStateSchema,
} from "../../contracts/auth.js";
import type { IpLimiter } from "../auth/rate-limit.js";
import type { Session, SessionStore } from "../auth/sessions.js";
import { sendApiError, sendApiSuccess } from "../response.js";

const COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

const logoutResponseSchema = z.object({ ok: z.literal(true) });

export type AuthRouteDeps = {
  sessions: SessionStore;
  rateLimiter: IpLimiter;
};

const cookieOpts = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: COOKIE_MAX_AGE_SECONDS,
};

const csrfCookieOpts = {
  httpOnly: false,
  sameSite: "strict" as const,
  path: "/",
  maxAge: COOKIE_MAX_AGE_SECONDS,
};

const setSessionCookies = (reply: FastifyReply, session: Session): void => {
  reply.setCookie("sov_session", session.sid, cookieOpts);
  reply.setCookie("sov_csrf", session.csrf, csrfCookieOpts);
};

const clearSessionCookies = (reply: FastifyReply): void => {
  reply.clearCookie("sov_session", { path: "/" });
  reply.clearCookie("sov_csrf", { path: "/" });
};

const requestIp = (request: FastifyRequest): string => request.ip;

export const registerAuthRoutes = (
  server: FastifyInstance,
  app: AppContainer,
  deps: AuthRouteDeps,
): void => {
  const { sessions, rateLimiter } = deps;

  server.get("/api/auth/state", async (request, reply) => {
    try {
      const stage = await app.installerService.getAuthStage();
      const sid = request.cookies?.sov_session;
      const session = sessions.get(sid);
      const result = {
        authenticated: session !== null,
        stage: stage.stage,
        ...(stage.username !== undefined ? { username: stage.username } : {}),
        ...(session !== null ? { csrf: session.csrf } : {}),
      };
      return sendApiSuccess(reply, result, authStateSchema);
    } catch (error) {
      return sendApiError(reply, 500, error);
    }
  });

  server.post("/api/auth/login", async (request, reply) => {
    const ip = requestIp(request);
    const limit = rateLimiter.check(ip);
    if (!limit.ok) {
      reply.header("Retry-After", String(limit.retryAfterSeconds));
      return sendApiError(reply, 429, {
        code: "RATE_LIMITED",
        message: "Too many login attempts; try again later",
        retryable: true,
        details: { retryAfterSeconds: limit.retryAfterSeconds },
      });
    }

    let body: { token?: string | undefined; password?: string | undefined };
    try {
      body = authLoginRequestSchema.parse(request.body);
    } catch (error) {
      return sendApiError(reply, 400, error);
    }

    let stage: { stage: "needs-bootstrap" | "needs-password"; username?: string };
    try {
      stage = await app.installerService.getAuthStage();
    } catch (error) {
      return sendApiError(reply, 500, error);
    }

    if (stage.stage === "needs-bootstrap") {
      const token = body.token;
      if (token === undefined) {
        rateLimiter.recordFailure(ip);
        return sendApiError(reply, 400, {
          code: "BOOTSTRAP_TOKEN_REQUIRED",
          message: "A bootstrap token is required while no operator credential is configured",
          retryable: false,
        });
      }
      const result = await app.installerService.consumeSetupUiBootstrapToken(token);
      if (!result.ok) {
        rateLimiter.recordFailure(ip);
        const status = result.reason === "not-issued" || result.reason === "consumed" ? 410 : 401;
        return sendApiError(reply, status, {
          code: `BOOTSTRAP_TOKEN_${result.reason.replace(/-/g, "_").toUpperCase()}`,
          message: `Bootstrap token ${result.reason}`,
          retryable: false,
        });
      }
      rateLimiter.recordSuccess(ip);
      const session = sessions.create({ kind: "bootstrap", username: "bootstrap" });
      setSessionCookies(reply, session);
      return sendApiSuccess(
        reply,
        { csrf: session.csrf, username: session.principal.username },
        authLoginResponseSchema,
      );
    }

    const password = body.password;
    if (password === undefined) {
      rateLimiter.recordFailure(ip);
      return sendApiError(reply, 400, {
        code: "PASSWORD_REQUIRED",
        message: "Password is required",
        retryable: false,
      });
    }
    const result = await app.installerService.verifyOperatorPassword(password);
    if (!result.ok) {
      rateLimiter.recordFailure(ip);
      if (result.reason === "homeserver-unreachable") {
        return sendApiError(reply, 503, {
          code: "HOMESERVER_UNREACHABLE",
          message: "Matrix homeserver is unreachable; cannot verify password",
          retryable: true,
        });
      }
      if (result.reason === "not-configured") {
        return sendApiError(reply, 409, {
          code: "OPERATOR_NOT_CONFIGURED",
          message: "Operator account is not yet configured on this installation",
          retryable: false,
        });
      }
      return sendApiError(reply, 401, {
        code: "INVALID_CREDENTIALS",
        message: "Invalid password",
        retryable: false,
      });
    }
    rateLimiter.recordSuccess(ip);
    const session = sessions.create({ kind: "matrix", username: result.username });
    setSessionCookies(reply, session);
    return sendApiSuccess(
      reply,
      { csrf: session.csrf, username: session.principal.username },
      authLoginResponseSchema,
    );
  });

  server.post("/api/auth/logout", async (request, reply) => {
    const sid = request.cookies?.sov_session;
    if (sid !== undefined) {
      sessions.revoke(sid);
    }
    clearSessionCookies(reply);
    return sendApiSuccess(reply, { ok: true } as const, logoutResponseSchema);
  });
};
