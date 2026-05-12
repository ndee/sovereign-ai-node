import { h, render } from "./vendor/preact.module.js";
import htm from "./vendor/htm.module.js";
import { useCallback, useEffect, useState } from "./vendor/preact-hooks.module.js";

import { apiGet, apiPost, clearAuth, setCsrf } from "./api.js";
import { navigate, useHashRoute } from "./router.js";
import { Login } from "./screens/login.js";
import { Onboarding } from "./screens/onboarding.js";
import { Reconfigure } from "./screens/reconfigure.js";
import { AdminStatus } from "./screens/admin/Status.js";
import { Recovery } from "./screens/admin/Recovery.js";
import { Wizard } from "./screens/wizard/index.js";

const html = htm.bind(h);

const ADMIN_NAV = [
  { label: "Status", path: "/admin/status", group: "Operate" },
  { label: "Mailbox", path: "/admin/mailbox", group: "Reconfigure" },
  { label: "Matrix", path: "/admin/matrix", group: "Reconfigure" },
  { label: "Provider", path: "/admin/provider", group: "Reconfigure" },
  { label: "Onboarding", path: "/admin/onboarding", group: "Operate" },
  { label: "Recovery", path: "/admin/recovery", group: "Operate" },
];

// Map old (pre-wizard) hash routes to the new IA, for one release cycle.
const LEGACY_REDIRECTS = {
  "/install": "/setup/welcome",
  "/status": "/admin/status",
  "/reconfigure/imap": "/admin/mailbox",
  "/reconfigure/matrix": "/admin/matrix",
  "/reconfigure/openrouter": "/admin/provider",
  "/onboarding": "/admin/onboarding",
};

const isWizardRoute = (route) => route === "/setup" || route.startsWith("/setup/");
const isAdminRoute = (route) => route === "/admin" || route.startsWith("/admin/");

const detectMode = (status) =>
  status?.installationId && status?.version?.provenance ? "admin" : "first-run";

const AdminNav = ({ active, onSignOut, signingOut }) => {
  const groups = ["Operate", "Reconfigure"];
  return html`
    <nav class="nav">
      <div class="nav__brand">
        Sovereign AI Node
        <small>Admin console</small>
      </div>
      ${groups.map(
        (group) => html`
          <div class="nav__group">${group}</div>
          ${ADMIN_NAV.filter((entry) => entry.group === group).map(
            (entry) => html`
              <a
                class=${`nav__link ${active === entry.path ? "nav__link--active" : ""}`}
                href=${`#${entry.path}`}
              >
                ${entry.label}
              </a>
            `,
          )}
        `,
      )}
      <div style="margin-top: auto; padding-top: 24px;">
        <button
          class="btn btn--secondary"
          type="button"
          onClick=${onSignOut}
          disabled=${signingOut}
          style="width: 100%;"
        >
          ${signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </nav>
  `;
};

const AdminScreen = ({ route, authState }) => {
  if (route === "/admin/status" || route === "/admin") {
    return html`<${AdminStatus} />`;
  }
  if (route === "/admin/mailbox") return html`<${Reconfigure} target="imap" />`;
  if (route === "/admin/matrix") return html`<${Reconfigure} target="matrix" />`;
  if (route === "/admin/provider") return html`<${Reconfigure} target="openrouter" />`;
  if (route === "/admin/onboarding") return html`<${Onboarding} />`;
  if (route === "/admin/recovery") return html`<${Recovery} authState=${authState} />`;
  return html`<${AdminStatus} />`;
};

const useStatus = (authReady) => {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [statusLoaded, setStatusLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setStatusError(null);
    try {
      const result = await apiGet("/api/status");
      setStatus(result);
    } catch (err) {
      setStatus(null);
      setStatusError(err);
    } finally {
      setStatusLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!authReady) return;
    refresh();
  }, [authReady, refresh]);

  return { status, statusError, statusLoaded, refreshStatus: refresh };
};

const App = () => {
  const route = useHashRoute();
  const [authState, setAuthState] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const refreshAuth = useCallback(async () => {
    try {
      const result = await apiGet("/api/auth/state");
      if (result.csrf) setCsrf(result.csrf);
      setAuthState(result);
    } catch {
      setAuthState({ authenticated: false, stage: "needs-bootstrap" });
    } finally {
      setAuthLoaded(true);
    }
  }, []);

  useEffect(() => {
    refreshAuth();
    const onUnauth = () => {
      clearAuth();
      setAuthState((prev) => (prev ? { ...prev, authenticated: false } : prev));
      refreshAuth();
    };
    window.addEventListener("sov:unauth", onUnauth);
    return () => window.removeEventListener("sov:unauth", onUnauth);
  }, [refreshAuth]);

  const onAuthenticated = useCallback(() => {
    refreshAuth();
  }, [refreshAuth]);

  const onSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await apiPost("/api/auth/logout", {});
    } catch {
      // ignore — clear local state anyway
    } finally {
      clearAuth();
      setSigningOut(false);
      refreshAuth();
    }
  }, [refreshAuth]);

  const authReady = authLoaded && authState?.authenticated === true;
  const { status, statusError, statusLoaded, refreshStatus } = useStatus(authReady);

  // Legacy hash redirect
  useEffect(() => {
    const target = LEGACY_REDIRECTS[route];
    if (target) navigate(target);
  }, [route]);

  // Mode-based redirects
  useEffect(() => {
    if (!authReady || !statusLoaded) return;
    if (statusError && status === null) return; // status unreachable; let the user retry
    const mode = detectMode(status);
    const wantsForce = window.location.hash.includes("force=1");

    if (mode === "first-run") {
      if (route === "/" || route === "") {
        navigate("/setup/welcome");
        return;
      }
      if (isAdminRoute(route)) {
        navigate("/setup/welcome");
        return;
      }
    } else {
      if (route === "/" || route === "") {
        navigate("/admin/status");
        return;
      }
      if (isWizardRoute(route) && !wantsForce) {
        navigate("/admin/status");
      }
    }
  }, [authReady, statusLoaded, statusError, status, route]);

  if (!authLoaded) {
    return html`
      <div class="splash">
        <p class="muted">Loading…</p>
      </div>
    `;
  }

  if (!authState?.authenticated) {
    return html`<${Login}
      stage=${authState?.stage ?? "needs-bootstrap"}
      username=${authState?.username}
      onAuthenticated=${onAuthenticated}
    />`;
  }

  if (!statusLoaded) {
    return html`
      <div class="splash">
        <p class="muted">Loading…</p>
      </div>
    `;
  }

  if (statusError && status === null) {
    return html`
      <div class="splash splash--error">
        <div class="card" style="max-width: 480px;">
          <h2>Could not load status</h2>
          <p class="muted">${statusError.detail?.message ?? statusError.message ?? "Unknown error."}</p>
          <div class="btn-row">
            <button class="btn" type="button" onClick=${refreshStatus}>Retry</button>
            <button class="btn btn--secondary" type="button" onClick=${onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    `;
  }

  const mode = detectMode(status);
  const wantsForce = window.location.hash.includes("force=1");

  if (mode === "first-run" || (isWizardRoute(route) && wantsForce)) {
    return html`<${Wizard} route=${route} onModeChange=${refreshStatus} />`;
  }

  return html`
    <div class="app-shell">
      <${AdminNav} active=${route} onSignOut=${onSignOut} signingOut=${signingOut} />
      <main class="main">
        <${AdminScreen} route=${route} authState=${authState} />
      </main>
    </div>
  `;
};

const root = document.getElementById("root");
if (root !== null) {
  render(html`<${App} />`, root);
}

export { detectMode, LEGACY_REDIRECTS, isWizardRoute, isAdminRoute };
