import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";
import { useState } from "../vendor/preact-hooks.module.js";

import { apiPost, setCsrf } from "../api.js";
import { ErrorBanner } from "../forms.js";

const html = htm.bind(h);

const TOKEN_ERROR_CODES = new Set([
  "BOOTSTRAP_TOKEN_CONSUMED",
  "BOOTSTRAP_TOKEN_EXPIRED",
  "BOOTSTRAP_TOKEN_INVALID",
  "BOOTSTRAP_TOKEN_LOCKED",
  "BOOTSTRAP_TOKEN_NOT_ISSUED",
]);

const isTokenError = (err) => {
  if (!err) return false;
  const code = err.detail?.code ?? err.code;
  return typeof code === "string" && TOKEN_ERROR_CODES.has(code);
};

export const Login = ({ stage, username, onAuthenticated }) => {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body =
        stage === "needs-bootstrap" ? { token: token.trim() } : { password };
      const result = await apiPost("/api/auth/login", body);
      setCsrf(result.csrf);
      onAuthenticated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const showTokenRecovery = stage === "needs-bootstrap" && isTokenError(error);

  return html`
    <div
      style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 32px;"
    >
      <div class="card" style="max-width: 460px; width: 100%;">
        <h1 style="font-size: 1.75rem; margin-bottom: 0.5em;">Sovereign AI Node</h1>
        <p class="muted" style="margin-bottom: 24px;">Open-core setup access</p>
        <${ErrorBanner} error=${error} />
        ${showTokenRecovery
          ? html`
              <div class="alert alert--info">
                Issue a fresh token on the node host:
                <code class="code-block">sudo sovereign-node setup-ui issue-bootstrap-token</code>
                Then paste the new token below.
              </div>
            `
          : null}
        <form onSubmit=${submit}>
          ${stage === "needs-bootstrap"
            ? html`
                <p class="muted" style="font-size: 0.92rem;">
                  Use the bootstrap token created during install to unlock local setup and
                  admin access.
                </p>
                <label class="field">
                  <span class="field__label">Bootstrap token</span>
                  <input
                    class="input"
                    type="text"
                    autocomplete="one-time-code"
                    placeholder="ABCD-EFGH-JKLM"
                    value=${token}
                    onInput=${(event) => setToken(event.currentTarget.value)}
                    disabled=${busy}
                  />
                </label>
                <p class="dim" style="font-size: 0.85rem; margin-top: 8px;">
                  No valid token? Issue a new one on the node host:
                  <code>sudo sovereign-node setup-ui issue-bootstrap-token</code>
                </p>
              `
            : html`
                <p class="muted" style="font-size: 0.92rem;">
                  Sign in as
                  <code>${username ?? "the operator"}</code>
                  with your Matrix password — the same one you use in Element.
                </p>
                <label class="field">
                  <span class="field__label">Matrix password</span>
                  <input
                    class="input"
                    type="password"
                    autocomplete="current-password"
                    value=${password}
                    onInput=${(event) => setPassword(event.currentTarget.value)}
                    disabled=${busy}
                  />
                </label>
              `}
          <div class="btn-row">
            <button class="btn" type="submit" disabled=${busy}>
              ${busy ? "Signing in…" : "Continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
};
