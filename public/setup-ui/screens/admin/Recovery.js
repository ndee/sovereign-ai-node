import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";

const html = htm.bind(h);

export const Recovery = ({ authState }) => html`
  <section class="hero">
    <h1>Recovery</h1>
    <p>
      Sign-posts for getting back into the node when something has gone wrong. None of these
      buttons run anything — they tell you where to go next.
    </p>
  </section>

  <section class="section">
    <div class="card">
      <h2>You're signed in</h2>
      <p class="muted">
        Stage: <code>${authState?.stage ?? "—"}</code> · User:
        <code>${authState?.username ?? "—"}</code>
      </p>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <h2>Re-issue Matrix onboarding code</h2>
      <p>
        Lost access to your Matrix account? You can issue a fresh one-time onboarding code from
        the onboarding page. Issuing a new code invalidates any previous unconsumed code.
      </p>
      <div class="btn-row">
        <a class="btn" href="#/admin/onboarding">Open onboarding</a>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <h2>Re-issue bootstrap token</h2>
      <p>
        If you've lost your Matrix credentials and can't sign in here, run this on the node host
        to get a fresh short-lived bootstrap token:
      </p>
      <code class="code-block">sudo sovereign-node setup-ui issue-bootstrap-token</code>
      <p class="muted">
        The command prints a one-time token you can paste into the login screen. It expires in
        24 hours.
      </p>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <h2>Break-glass commands</h2>
      <p>Everything here can also be done from the terminal on the node host:</p>
      <ul class="bullet-list">
        <li><code>sovereign-node doctor</code> — runs diagnostics across the stack.</li>
        <li><code>sovereign-node logs</code> — recent service logs.</li>
        <li><code>sovereign-node reconfigure</code> — interactive reconfigure flow.</li>
      </ul>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <h2>Don't know what's wrong?</h2>
      <p>Start at <a href="#/admin/status">Status</a> — it surfaces critical actions first.</p>
    </div>
  </section>
`;
