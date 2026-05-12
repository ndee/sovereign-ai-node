import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useCallback } from "../../vendor/preact-hooks.module.js";

import { apiGet } from "../../api.js";
import { ErrorBanner } from "../../forms.js";
import { usePoll } from "../../progress.js";

const html = htm.bind(h);

const ORDER = { healthy: 0, degraded: 1, unhealthy: 2 };

const worst = (values) => {
  let result = "healthy";
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if ((ORDER[value] ?? 0) > (ORDER[result] ?? 0)) result = value;
  }
  return result;
};

const HEALTH_TONE = {
  healthy: "ok",
  degraded: "warn",
  unhealthy: "fail",
};

const HEALTH_HEADLINE = {
  healthy: "All systems healthy",
  degraded: "Running with warnings",
  unhealthy: "Action needed",
};

const buildOverall = (status) => {
  if (!status) return "healthy";
  return worst([
    ...(status.services ?? []).map((s) => s.health),
    status.matrix?.health,
    status.openclaw?.health,
    ...Object.values(status.bots ?? {}).map((b) => b.health),
    ...(status.hostResources ?? []).map((r) => r.health),
    status.imap?.authStatus === "failed" ? "unhealthy" : "healthy",
  ]);
};

const buildCriticalActions = (status) => {
  if (!status) return [];
  const actions = [];

  for (const service of status.services ?? []) {
    if (service.health === "unhealthy") {
      actions.push({
        title: service.name,
        detail: service.message ?? "Service is unhealthy.",
        cta: { href: "#/admin/recovery", label: "Open recovery" },
      });
    }
  }

  if (status.imap?.authStatus === "failed") {
    actions.push({
      title: "Mailbox authentication failed",
      detail:
        "Mail Sentinel can't sign in to your mailbox. Reconfigure with new credentials, then test.",
      cta: { href: "#/admin/mailbox", label: "Reconfigure mailbox" },
    });
  }

  if (status.matrix && status.matrix.roomReachable === false && status.installationId) {
    actions.push({
      title: "Alert room unreachable",
      detail: "The Matrix alert room is not currently reachable from this node.",
      cta: { href: "#/admin/matrix", label: "Reconfigure Matrix" },
    });
  }

  return actions;
};

const groupServices = (status) => {
  const groups = { healthy: [], degraded: [], unhealthy: [] };
  for (const service of status?.services ?? []) {
    const bucket = groups[service.health] ?? groups.degraded;
    bucket.push({
      key: `service:${service.name}`,
      name: service.name,
      detail: service.message ?? service.kind,
      health: service.health,
    });
  }
  if (status?.matrix) {
    groups[status.matrix.health].push({
      key: "matrix",
      name: "Matrix homeserver",
      detail: status.matrix.homeserverUrl ?? "—",
      health: status.matrix.health,
    });
  }
  if (status?.openclaw) {
    groups[status.openclaw.health].push({
      key: "openclaw",
      name: "OpenClaw runtime",
      detail: status.openclaw.serviceState ?? "—",
      health: status.openclaw.health,
    });
  }
  for (const [botId, bot] of Object.entries(status?.bots ?? {})) {
    groups[bot.health].push({
      key: `bot:${botId}`,
      name: botId,
      detail: "module",
      health: bot.health,
    });
  }
  return groups;
};

const Group = ({ title, items, tone }) => {
  if (!items || items.length === 0) return null;
  return html`
    <div class="card">
      <h3>${title}</h3>
      <ul class="steps">
        ${items.map(
          (item) => html`
            <li>
              <span>
                ${item.name}
                ${item.detail ? html`<br /><span class="dim">${item.detail}</span>` : null}
              </span>
              <span class=${`badge badge--${tone}`}>${item.health}</span>
            </li>
          `,
        )}
      </ul>
    </div>
  `;
};

export const AdminStatus = () => {
  const fetcher = useCallback(() => apiGet("/api/status"), []);
  const { data, error } = usePoll(fetcher, 5000);

  if (error && data === null) {
    return html`
      <section class="hero">
        <h1>Status</h1>
        <p>Could not load status. The API may be unreachable.</p>
      </section>
      <${ErrorBanner} error=${error} />
    `;
  }

  if (data === null) {
    return html`
      <section class="hero">
        <h1>Status</h1>
        <p class="muted">Loading…</p>
      </section>
    `;
  }

  const overall = buildOverall(data);
  const tone = HEALTH_TONE[overall];
  const headline = HEALTH_HEADLINE[overall];
  const actions = buildCriticalActions(data);
  const groups = groupServices(data);

  return html`
    <section class="hero">
      <h1>
        ${headline}
        <span class=${`badge badge--${tone}`} style="margin-left: 16px; vertical-align: middle;">
          ${overall}
        </span>
      </h1>
      <p>Refreshes every 5 seconds. As of ${data.generatedAt ?? "—"}.</p>
    </section>

    ${actions.length > 0
      ? html`
          <section class="section">
            <div class="alert alert--error">
              <strong>Action needed.</strong>
              <ul class="bullet-list" style="margin-top: 8px;">
                ${actions.map(
                  (a) => html`
                    <li>
                      <strong>${a.title}.</strong> ${a.detail}
                      ${a.cta
                        ? html` <a href=${a.cta.href}>${a.cta.label}</a>`
                        : null}
                    </li>
                  `,
                )}
              </ul>
            </div>
          </section>
        `
      : null}

    <section class="section">
      <${Group} title="Errors" items=${groups.unhealthy} tone="fail" />
      <${Group} title="Warnings" items=${groups.degraded} tone="warn" />
      <${Group} title="Healthy" items=${groups.healthy} tone="ok" />
    </section>

    <section class="section">
      <details class="card">
        <summary>Service detail</summary>
        <table class="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Kind</th>
              <th>State</th>
              <th>Health</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            ${(data.services ?? []).map(
              (service) => html`
                <tr>
                  <td><code>${service.name}</code></td>
                  <td class="dim">${service.kind}</td>
                  <td>
                    <span class=${`badge badge--${service.state}`}>${service.state}</span>
                  </td>
                  <td>
                    <span class=${`badge badge--${HEALTH_TONE[service.health]}`}>
                      ${service.health}
                    </span>
                  </td>
                  <td class="muted">${service.message ?? ""}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </details>
    </section>
  `;
};

export { buildOverall, buildCriticalActions, worst };
