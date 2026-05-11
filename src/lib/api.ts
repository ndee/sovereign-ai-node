export {
  type AuthPreHandlerOptions,
  createAuthPreHandler,
} from "../api/auth/middleware.js";
export {
  createIpLimiter,
  type IpLimiter,
  type IpLimiterOptions,
  type RateLimitCheck,
} from "../api/auth/rate-limit.js";
export {
  createSessionStore,
  type Session,
  type SessionPrincipal,
  type SessionPrincipalKind,
  type SessionStore,
  type SessionStoreOptions,
} from "../api/auth/sessions.js";
export { sendApiError, sendApiSuccess } from "../api/response.js";
export { type AuthRouteDeps, registerAuthRoutes } from "../api/routes/auth.js";
export { registerInstallRoutes } from "../api/routes/install.js";
export { registerOnboardingRoutes } from "../api/routes/onboarding.js";
export { registerReconfigureRoutes } from "../api/routes/reconfigure.js";
export { registerSetupUiRoutes, resolveSetupUiRoot } from "../api/routes/setup-ui.js";
export { registerStatusRoutes } from "../api/routes/status.js";
export { buildApiServer } from "../api/server.js";
