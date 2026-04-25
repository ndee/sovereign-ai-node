import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";
import { useEffect, useState } from "../vendor/preact-hooks.module.js";

import { apiGet, apiPost } from "../api.js";
import { ErrorBanner } from "../forms.js";

const html = htm.bind(h);

const DEFAULT_REQUEST = {
  mode: "bundled_matrix",
  matrix: {
    homeserverDomain: "matrix.example.test",
    publicBaseUrl: "https://matrix.example.test",
  },
  operator: {
    username: "operator",
  },
  openrouter: {
    model: "qwen/qwen3.5-9b",
    apiKey: "",
  },
};

const Badge = ({ state }) => html`<span class=${`badge badge--${state}`}>${state}</span>`;

export const Install = () => {
  const [requestText, setRequestText] = useState(JSON.stringify(DEFAULT_REQUEST, null, 2));
  const [preflight, setPreflight] = useState(null);
  const [preflightError, setPreflightError] = useState(null);
  const [preflightBusy, setPreflightBusy] = useState(false);

  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [installError, setInstallError] = useState(null);
  const [installBusy, setInstallBusy] = useState(false);

  const parseRequest = () => {
    try {
      return JSON.parse(requestText);
    } catch (err) {
      throw new Error(`Invalid JSON: ${err.message}`);
    }
  };

  const runPreflight = async () => {
    setPreflightBusy(true);
    setPreflightError(null);
    try {
      const body = parseRequest();
      const result = await apiPost("/api/install/preflight", body);
      setPreflight(result);
    } catch (err) {
      setPreflightError(err);
    } finally {
      setPreflightBusy(false);
    }
  };

  const startInstall = async () => {
    setInstallBusy(true);
    setInstallError(null);
    setJob(null);
    try {
      const body = parseRequest();
      const result = await apiPost("/api/install/run", body);
      setJobId(result.job.jobId);
      setJob(result.job);
    } catch (err) {
      setInstallError(err);
      setInstallBusy(false);
    }
  };

  useEffect(() => {
    if (jobId === null) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const result = await apiGet(`/api/install/jobs/${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        setJob(result.job);
        const state = result.job.state;
        if (state === "succeeded" || state === "failed" || state === "canceled") {
          setInstallBusy(false);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setInstallError(err);
        setInstallBusy(false);
        return;
      }
      timer = window.setTimeout(tick, 1000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [jobId]);

  return html`
    <section class="hero">
      <h1>Install Sovereign AI Node</h1>
      <p>
        Run preflight checks first, then start the install. Progress streams from the API as steps
        complete.
      </p>
    </section>

    <section class="section">
      <div class="card">
        <h2>Install request</h2>
        <p class="muted">
          Paste or edit the install request JSON. The shape mirrors
          <code>installRequestSchema</code> from <code>src/contracts/install.ts</code>.
        </p>
        <textarea
          class="textarea input"
          rows="14"
          spellcheck="false"
          value=${requestText}
          onInput=${(event) => setRequestText(event.currentTarget.value)}
          style="font-family: ui-monospace, monospace; font-size: 0.85rem;"
        ></textarea>
        <div class="btn-row">
          <button
            class="btn btn--secondary"
            type="button"
            disabled=${preflightBusy || installBusy}
            onClick=${runPreflight}
          >
            ${preflightBusy ? "Running…" : "Run preflight"}
          </button>
          <button
            class="btn"
            type="button"
            disabled=${installBusy || preflightBusy}
            onClick=${startInstall}
          >
            ${installBusy ? "Installing…" : "Run install"}
          </button>
        </div>
      </div>
    </section>

    ${preflightError ? html`<${ErrorBanner} error=${preflightError} />` : null}
    ${preflight
      ? html`
          <section class="section">
            <div class="card">
              <h2>Preflight: <${Badge} state=${preflight.overall} /></h2>
              <ul class="steps">
                ${preflight.checks.map(
                  (check) => html`
                    <li>
                      <span>${check.name}<br /><span class="dim">${check.message ?? ""}</span></span>
                      <${Badge} state=${check.status} />
                    </li>
                  `,
                )}
              </ul>
              ${preflight.recommendedActions.length > 0
                ? html`
                    <h3>Recommended actions</h3>
                    <ul>
                      ${preflight.recommendedActions.map((action) => html`<li>${action}</li>`)}
                    </ul>
                  `
                : null}
            </div>
          </section>
        `
      : null}

    ${installError ? html`<${ErrorBanner} error=${installError} />` : null}
    ${job
      ? html`
          <section class="section">
            <div class="card">
              <h2>Install job <${Badge} state=${job.state} /></h2>
              <p class="dim"><code>${job.jobId}</code></p>
              <ul class="steps">
                ${job.steps.map(
                  (step) => html`
                    <li>
                      <span>${step.label}</span>
                      <${Badge} state=${step.state} />
                    </li>
                  `,
                )}
              </ul>
            </div>
          </section>
        `
      : null}
  `;
};
