import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";
import { useCallback } from "../vendor/preact-hooks.module.js";

import { apiGet } from "../api.js";
import { ErrorBanner } from "../forms.js";
import { usePoll } from "../progress.js";

const html = htm.bind(h);

const Badge = ({ state }) => html`<span class=${`badge badge--${state}`}>${state}</span>`;

export const Status = () => {
  const fetcher = useCallback(() => apiGet("/api/status"), []);
  const { data, error } = usePoll(fetcher, 5000);

  return html`
    <section class="hero">
      <h1>Status</h1>
      <p>Live view of installed services and the runtime mode. Refreshes every 5 seconds.</p>
    </section>

    ${error ? html`<${ErrorBanner} error=${error} />` : null}

    ${data
      ? html`
          <section class="section">
            <div class="card">
              <h2>Mode: <code>${data.mode}</code></h2>
              <p class="dim">As of ${data.generatedAt ?? "—"}</p>
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
                        <td><${Badge} state=${service.state} /></td>
                        <td><${Badge} state=${service.health} /></td>
                        <td class="muted">${service.message ?? ""}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          </section>
        `
      : !error
        ? html`<p class="muted">Loading…</p>`
        : null}
  `;
};
