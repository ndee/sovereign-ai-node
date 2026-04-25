import { h, render } from "./vendor/preact.module.js";
import htm from "./vendor/htm.module.js";
import { useCallback, useEffect, useState } from "./vendor/preact-hooks.module.js";

import { apiGet, apiPost, clearAuth, setCsrf } from "./api.js";
import { useHashRoute } from "./router.js";
import { Install } from "./screens/install.js";
import { Login } from "./screens/login.js";
import { Onboarding } from "./screens/onboarding.js";
import { Reconfigure } from "./screens/reconfigure.js";
import { Status } from "./screens/status.js";

const html = htm.bind(h);

const NAV = [
  { label: "Install", path: "/install", group: "Setup" },
  { label: "Status", path: "/status", group: "Operate" },
  { label: "IMAP", path: "/reconfigure/imap", group: "Reconfigure" },
  { label: "Matrix", path: "/reconfigure/matrix", group: "Reconfigure" },
  { label: "OpenRouter", path: "/reconfigure/openrouter", group: "Reconfigure" },
  { label: "Onboarding code", path: "/onboarding", group: "Operate" },
];

const matchRoute = (route) => {
  if (route === "/" || route === "/install") return { name: "install" };
  if (route === "/status") return { name: "status" };
  if (route === "/reconfigure/imap") return { name: "reconfigure", target: "imap" };
  if (route === "/reconfigure/matrix") return { name: "reconfigure", target: "matrix" };
  if (route === "/reconfigure/openrouter") return { name: "reconfigure", target: "openrouter" };
  if (route === "/onboarding") return { name: "onboarding" };
  return { name: "install" };
};

const Nav = ({ active, onSignOut, signingOut }) => {
  const groups = ["Setup", "Operate", "Reconfigure"];
  return html`
    <nav class="nav">
      <div class="nav__brand">
        Sovereign AI Node
        <small>Setup &amp; admin</small>
      </div>
      ${groups.map(
        (group) => html`
          <div class="nav__group">${group}</div>
          ${NAV.filter((entry) => entry.group === group).map(
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

const Screen = ({ route }) => {
  const matched = matchRoute(route);
  if (matched.name === "install") return html`<${Install} />`;
  if (matched.name === "status") return html`<${Status} />`;
  if (matched.name === "reconfigure") return html`<${Reconfigure} target=${matched.target} />`;
  if (matched.name === "onboarding") return html`<${Onboarding} />`;
  return null;
};

const Splash = () =>
  html`<div style="min-height: 100vh; display: flex; align-items: center; justify-content: center;">
    <p class="muted">Loading…</p>
  </div>`;

const App = () => {
  const route = useHashRoute();
  const activePath = route === "/" ? "/install" : route;
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
      // ignore — we'll clear local state anyway
    } finally {
      clearAuth();
      setSigningOut(false);
      refreshAuth();
    }
  }, [refreshAuth]);

  if (!authLoaded) return html`<${Splash} />`;
  if (!authState?.authenticated) {
    return html`<${Login}
      stage=${authState?.stage ?? "needs-bootstrap"}
      username=${authState?.username}
      onAuthenticated=${onAuthenticated}
    />`;
  }

  return html`
    <div class="app-shell">
      <${Nav} active=${activePath} onSignOut=${onSignOut} signingOut=${signingOut} />
      <main class="main">
        <${Screen} route=${route} />
      </main>
    </div>
  `;
};

const root = document.getElementById("root");
if (root !== null) {
  render(html`<${App} />`, root);
}
