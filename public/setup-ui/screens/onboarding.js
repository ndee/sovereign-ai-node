import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";
import { useEffect, useState } from "../vendor/preact-hooks.module.js";

import { apiGet, apiPost } from "../api.js";
import { ErrorBanner } from "../forms.js";

const html = htm.bind(h);

const isOutstanding = (state) => {
  if (state === null) return false;
  if (state.consumedAt !== undefined) return false;
  if (Date.parse(state.expiresAt) <= Date.now()) return false;
  if (state.failedAttempts >= state.maxAttempts) return false;
  return true;
};

const copy = async (value) => {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard API unavailable; the value is still selectable in the UI.
  }
};

const ConfirmDialog = ({ onCancel, onConfirm, busy }) => html`
  <div class="modal-backdrop" onClick=${onCancel}>
    <div class="modal" onClick=${(event) => event.stopPropagation()}>
      <h2>Invalidate existing code?</h2>
      <p class="muted">
        An onboarding code is currently outstanding. Issuing a new one will invalidate it
        immediately — anyone holding the old code will no longer be able to redeem it.
      </p>
      <div class="btn-row">
        <button class="btn btn--secondary" type="button" onClick=${onCancel} disabled=${busy}>
          Cancel
        </button>
        <button class="btn" type="button" onClick=${onConfirm} disabled=${busy}>
          ${busy ? "Issuing…" : "Issue new code"}
        </button>
      </div>
    </div>
  </div>
`;

export const Onboarding = () => {
  const [state, setState] = useState(null);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const loadState = async () => {
    try {
      const result = await apiGet("/api/onboarding/state");
      setState(result);
      setStateLoaded(true);
    } catch (err) {
      setError(err);
      setStateLoaded(true);
    }
  };

  useEffect(() => {
    loadState();
  }, []);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost("/api/onboarding/issue", {});
      setIssued(result);
      setConfirming(false);
      await loadState();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const onIssueClick = () => {
    if (isOutstanding(state)) {
      setConfirming(true);
    } else {
      issue();
    }
  };

  const renderState = () => {
    if (!stateLoaded) return html`<p class="muted">Loading…</p>`;
    if (state === null) {
      return html`
        <div class="alert alert--info">
          No onboarding code has been issued yet on this installation.
        </div>
      `;
    }
    const outstanding = isOutstanding(state);
    return html`
      <dl class="kv">
        <dt>Operator user</dt>
        <dd>${state.username}</dd>
        <dt>Homeserver</dt>
        <dd>${state.homeserverUrl}</dd>
        <dt>Issued at</dt>
        <dd>${state.issuedAt}</dd>
        <dt>Expires at</dt>
        <dd>${state.expiresAt}</dd>
        ${state.consumedAt !== undefined
          ? html`
              <dt>Consumed at</dt>
              <dd>${state.consumedAt}</dd>
            `
          : null}
        <dt>Failed attempts</dt>
        <dd>${state.failedAttempts} / ${state.maxAttempts}</dd>
        <dt>Status</dt>
        <dd>
          <span class=${`badge badge--${outstanding ? "running" : "fail"}`}>
            ${outstanding ? "outstanding" : "not redeemable"}
          </span>
        </dd>
      </dl>
    `;
  };

  return html`
    <section class="hero">
      <h1>Matrix onboarding code</h1>
      <p>
        Issue a one-time code that lets the operator sign in from a Matrix client. Each new code
        invalidates any previous unconsumed code.
      </p>
    </section>

    ${error ? html`<${ErrorBanner} error=${error} />` : null}

    <section class="section">
      <div class="card">
        <h2>Current state</h2>
        ${renderState()}
        <div class="btn-row">
          <button class="btn" type="button" onClick=${onIssueClick} disabled=${busy}>
            ${busy ? "Issuing…" : "Issue new code"}
          </button>
        </div>
      </div>
    </section>

    ${issued
      ? html`
          <section class="section">
            <div class="card">
              <h2>Issued</h2>
              <p class="muted">Hand this code and link to the operator. Expires ${issued.expiresAt}.</p>
              <code class="code-block code-block--lg">${issued.code}</code>
              <div class="btn-row">
                <button
                  class="btn btn--secondary"
                  type="button"
                  onClick=${() => copy(issued.code)}
                >
                  Copy code
                </button>
                <button
                  class="btn btn--secondary"
                  type="button"
                  onClick=${() => copy(issued.onboardingLink)}
                >
                  Copy link
                </button>
                <a class="btn btn--secondary" href=${issued.onboardingLink} target="_blank" rel="noreferrer">
                  Open link
                </a>
              </div>
              <h3 style="margin-top: 18px;">Onboarding URL</h3>
              <code class="code-block">${issued.onboardingUrl}</code>
              <h3>Onboarding link</h3>
              <code class="code-block">${issued.onboardingLink}</code>
            </div>
          </section>
        `
      : null}

    ${confirming
      ? html`
          <${ConfirmDialog}
            onCancel=${() => setConfirming(false)}
            onConfirm=${issue}
            busy=${busy}
          />
        `
      : null}
  `;
};
