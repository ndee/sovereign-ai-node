import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useEffect, useRef, useState } from "../../vendor/preact-hooks.module.js";

import { apiGet, apiPost } from "../../api.js";
import { WizardShell } from "../../components/WizardShell.js";
import { ErrorBanner } from "../../forms.js";
import { buildInstallRequest } from "./state.js";

const html = htm.bind(h);

const PHASE_OF = (stepId) => {
  if (stepId === "preflight") return "Preparing runtime";
  if (stepId === "openclaw_bootstrap_cli" || stepId === "openclaw_bundled_plugin_tools") {
    return "Installing OpenClaw";
  }
  if (stepId === "imap_validate") return "Connecting mailbox";
  if (stepId === "relay_enroll") return "Connecting relay";
  if (
    stepId === "matrix_provision" ||
    stepId === "matrix_bootstrap_accounts" ||
    stepId === "matrix_bootstrap_room"
  ) {
    return "Connecting Matrix";
  }
  if (
    stepId === "openclaw_gateway_service_install" ||
    stepId === "openclaw_configure" ||
    stepId === "bots_configure"
  ) {
    return "Activating modules";
  }
  if (stepId === "mail_sentinel_scan_timer" || stepId === "mail_sentinel_register") {
    return "Activating Mail Sentinel";
  }
  if (stepId === "smoke_checks" || stepId === "test_alert") return "Finalizing node";
  return "Installing";
};

const groupSteps = (steps) => {
  const phases = new Map();
  for (const step of steps) {
    const phase = PHASE_OF(step.id);
    if (!phases.has(phase)) {
      phases.set(phase, { phase, steps: [] });
    }
    phases.get(phase).steps.push(step);
  }
  return Array.from(phases.values()).map((entry) => {
    const states = entry.steps.map((s) => s.state);
    let state = "pending";
    if (states.some((s) => s === "failed")) state = "failed";
    else if (states.some((s) => s === "running")) state = "running";
    else if (states.every((s) => s === "succeeded" || s === "skipped")) {
      state = states.every((s) => s === "skipped") ? "skipped" : "succeeded";
    } else if (states.some((s) => s === "succeeded")) {
      state = "running";
    }
    return { ...entry, state };
  });
};

const PHASE_TONE = {
  pending: "pending",
  running: "running",
  succeeded: "ok",
  failed: "fail",
  skipped: "pending",
};

export const ProgressStep = ({ wizardState, secrets, onUpdateWizard, onBack, onSucceeded, onFailed }) => {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(wizardState.jobId === null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return undefined;
    if (wizardState.jobId !== null) {
      startedRef.current = true;
      return undefined;
    }
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const request = buildInstallRequest(wizardState, secrets);
        const response = await apiPost("/api/install/run", request);
        if (cancelled) return;
        onUpdateWizard({ jobId: response.job.jobId });
        setJob(response.job);
      } catch (err) {
        if (cancelled) return;
        setError(err);
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (wizardState.jobId === null) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const result = await apiGet(
          `/api/install/jobs/${encodeURIComponent(wizardState.jobId)}`,
        );
        if (cancelled) return;
        setJob(result.job);
        if (result.job.state === "succeeded") {
          onSucceeded(result);
          return;
        }
        if (result.job.state === "failed" || result.job.state === "canceled") {
          onFailed(result);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err);
        return;
      }
      timer = window.setTimeout(tick, 1000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardState.jobId]);

  const phases = job ? groupSteps(job.steps) : [];

  return html`
    <${WizardShell}
      stepIndex=${7}
      title="Installing"
      subtitle="Hang tight — this typically takes 2–5 minutes."
      onBack=${onBack}
      showBack=${false}
      showNext=${false}
    >
      ${error ? html`<${ErrorBanner} error=${error} />` : null}
      ${starting ? html`<p class="muted">Starting install…</p>` : null}
      ${phases.length > 0
        ? html`
            <ul class="steps phase-steps">
              ${phases.map(
                (p) => html`
                  <li>
                    <span>${p.phase}</span>
                    <span class=${`badge badge--${PHASE_TONE[p.state]}`}>${p.state}</span>
                  </li>
                `,
              )}
            </ul>
          `
        : null}
      ${job
        ? html`
            <details class="phase-detail">
              <summary>Step detail</summary>
              <ul class="steps">
                ${job.steps.map(
                  (step) => html`
                    <li>
                      <span>${step.label}</span>
                      <span class=${`badge badge--${step.state}`}>${step.state}</span>
                    </li>
                  `,
                )}
              </ul>
            </details>
          `
        : null}
    <//>
  `;
};
