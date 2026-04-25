import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";

const html = htm.bind(h);

const STATUS_TONE = {
  pass: "ok",
  ok: "ok",
  succeeded: "ok",
  fail: "fail",
  failed: "fail",
  error: "fail",
  warn: "warn",
  warning: "warn",
  skip: "pending",
  skipped: "pending",
  pending: "pending",
  running: "running",
  unknown: "pending",
};

const toneFor = (status) => STATUS_TONE[status] ?? "pending";

export const CheckList = ({ checks }) => {
  if (!checks || checks.length === 0) {
    return html`<p class="muted">No checks reported.</p>`;
  }
  return html`
    <ul class="steps">
      ${checks.map(
        (check) => html`
          <li>
            <span>
              ${check.name ?? check.id}
              ${check.message
                ? html`<br /><span class="dim">${check.message}</span>`
                : null}
            </span>
            <span class=${`badge badge--${toneFor(check.status)}`}>${check.status}</span>
          </li>
        `,
      )}
    </ul>
  `;
};
