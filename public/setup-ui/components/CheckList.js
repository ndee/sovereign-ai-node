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

// Map raw preflight check IDs from src/system/preflight.ts to product-facing
// labels. Keep the keys in sync with the backend ids; anything not listed
// falls back to the original id so we never silently drop a new check.
const FRIENDLY_LABEL = {
  "sudo-access": "Elevated privileges",
  "ports-80-443": "Ports 80 and 443",
  "disk-space-root": "Disk space (root volume)",
  "docker-cli": "Docker",
  "docker-compose": "Docker Compose",
  "matrix-domain-dns": "Homeserver DNS",
  "openclaw-dns": "Runtime backend DNS",
  "clock-sync": "System clock sync",
  "host-os": "Host OS",
  "node-version": "Installer runtime",
};

// Practical importance order for the operator. Anything not listed sorts to
// the bottom in id-alphabetical order, so a new backend check still appears.
const PRIORITY = [
  "sudo-access",
  "ports-80-443",
  "disk-space-root",
  "docker-cli",
  "docker-compose",
  "matrix-domain-dns",
  "openclaw-dns",
  "clock-sync",
  "host-os",
  "node-version",
];

const labelFor = (check) => {
  const id = check.id ?? check.name;
  return FRIENDLY_LABEL[id] ?? check.name ?? id;
};

const sortChecks = (checks) => {
  const indexOf = (c) => {
    const idx = PRIORITY.indexOf(c.id ?? c.name);
    return idx === -1 ? PRIORITY.length : idx;
  };
  return [...checks].sort((a, b) => {
    const ai = indexOf(a);
    const bi = indexOf(b);
    if (ai !== bi) return ai - bi;
    return (a.id ?? a.name ?? "").localeCompare(b.id ?? b.name ?? "");
  });
};

export const CheckList = ({ checks }) => {
  if (!checks || checks.length === 0) {
    return html`<p class="muted">No checks reported.</p>`;
  }
  return html`
    <ul class="steps">
      ${sortChecks(checks).map(
        (check) => html`
          <li>
            <span>
              ${labelFor(check)}
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
