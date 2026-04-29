import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";
import { useState } from "../vendor/preact-hooks.module.js";

import { apiPost, setCsrf } from "../api.js";
import { ErrorBanner } from "../forms.js";

const html = htm.bind(h);

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

  return html`
    <div
      style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 32px;"
    >
      <div class="card" style="max-width: 460px; width: 100%;">
        <h1 style="font-size: 1.75rem; margin-bottom: 0.5em;">Sovereign AI Node</h1>
        <p class="muted" style="margin-bottom: 24px;">Setup &amp; admin sign-in</p>
        <${ErrorBanner} error=${error} />
        <form onSubmit=${submit}>
          ${stage === "needs-bootstrap"
            ? html`
                <p class="muted" style="font-size: 0.92rem;">
                  No operator credential is configured yet. Enter the bootstrap token printed
                  during install (or run
                  <code>sudo sovereign-node setup-ui issue-bootstrap-token</code> to get a new
                  one).
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
              ${busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
};
