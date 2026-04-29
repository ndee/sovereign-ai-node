import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useEffect, useState } from "../../vendor/preact-hooks.module.js";

import { apiGet, apiPost } from "../../api.js";
import { WizardShell } from "../../components/WizardShell.js";
import { ErrorBanner } from "../../forms.js";

const html = htm.bind(h);

const copy = async (value) => {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard unavailable; the value is selectable in the UI.
  }
};

const isOutstanding = (state) => {
  if (state === null) return false;
  if (state.consumedAt !== undefined) return false;
  if (Date.parse(state.expiresAt) <= Date.now()) return false;
  if (state.failedAttempts >= state.maxAttempts) return false;
  return true;
};

export const SuccessStep = ({ result, onManageNode }) => {
  const [issued, setIssued] = useState(null);
  const [issueError, setIssueError] = useState(null);
  const [busy, setBusy] = useState(false);
  const nextSteps = result?.nextSteps;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const state = await apiGet("/api/onboarding/state");
        if (cancelled) return;
        if (isOutstanding(state)) {
          // Don't auto-invalidate an outstanding code.
          setBusy(false);
          return;
        }
        const response = await apiPost("/api/onboarding/issue", {});
        if (cancelled) return;
        setIssued(response);
      } catch (err) {
        if (!cancelled) setIssueError(err);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reissue = async () => {
    setBusy(true);
    setIssueError(null);
    try {
      const response = await apiPost("/api/onboarding/issue", {});
      setIssued(response);
    } catch (err) {
      setIssueError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <${WizardShell}
      stepIndex=${8}
      title="Your node is ready"
      subtitle="From here, the rest of operations happens in Matrix."
      showBack=${false}
      showNext=${false}
    >
      ${nextSteps
        ? html`
            <a
              class="btn btn--xl"
              href=${nextSteps.elementHomeserverUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open Element →
            </a>
            <dl class="kv kv--compact">
              <dt>Operator</dt>
              <dd>${nextSteps.operatorUsername}</dd>
              <dt>Alert room</dt>
              <dd>${nextSteps.roomName}</dd>
              <dt>Homeserver</dt>
              <dd>${nextSteps.elementHomeserverUrl}</dd>
            </dl>
            ${nextSteps.notes && nextSteps.notes.length > 0
              ? html`
                  <ul class="bullet-list">
                    ${nextSteps.notes.map((note) => html`<li>${note}</li>`)}
                  </ul>
                `
              : null}
          `
        : null}

      ${issueError ? html`<${ErrorBanner} error=${issueError} />` : null}
      ${busy && issued === null
        ? html`<p class="muted">Issuing your one-time onboarding code…</p>`
        : null}
      ${issued
        ? html`
            <h3>One-time onboarding code</h3>
            <p class="muted">
              Use this code to sign in from Element. It expires ${issued.expiresAt}.
            </p>
            <code class="code-block code-block--lg">${issued.code}</code>
            <div class="btn-row">
              <button class="btn btn--secondary" type="button" onClick=${() => copy(issued.code)}>
                Copy code
              </button>
              <button
                class="btn btn--secondary"
                type="button"
                onClick=${() => copy(issued.onboardingLink)}
              >
                Copy link
              </button>
              <a
                class="btn btn--secondary"
                href=${issued.onboardingLink}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open onboarding link
              </a>
            </div>
          `
        : html`
            ${!busy
              ? html`
                  <div class="btn-row">
                    <button class="btn" type="button" onClick=${reissue} disabled=${busy}>
                      Issue onboarding code
                    </button>
                  </div>
                `
              : null}
          `}

      <div class="alert alert--info">
        Sign in to Element with the code, accept the invite to your alert room, and close this
        tab when you're done. You can come back here later for credential changes.
      </div>

      <p class="dim wizard-step__exit">
        Need to manage this node from the browser? <a href="#/admin/status" onClick=${onManageNode}>Open the admin console.</a>
      </p>
    <//>
  `;
};
