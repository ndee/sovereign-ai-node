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

const findFailedStep = (steps) => steps?.find((s) => s.state === "failed") ?? null;

export const ProgressStep = ({
  wizardState,
  secrets,
  onUpdateWizard,
  onBackToReview,
  onSucceeded,
}) => {
  const [job, setJob] = useState(null);
  const [terminalResult, setTerminalResult] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(wizardState.jobId === null);
  const [submitElapsed, setSubmitElapsed] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const startedRef = useRef(false);

  // Submit POST /api/install/run once. Re-run when retryCount changes (manual retry).
  useEffect(() => {
    if (wizardState.jobId !== null) {
      // We already have a job id from a prior session; the polling effect will pick it up.
      startedRef.current = true;
      setSubmitting(false);
      return undefined;
    }
    if (startedRef.current && retryCount === 0) return undefined;
    startedRef.current = true;
    let cancelled = false;
    setSubmitting(true);
    setError(null);
    setTerminalResult(null);
    setJob(null);
    (async () => {
      try {
        const request = buildInstallRequest(wizardState, secrets);
        const response = await apiPost("/api/install/run", request);
        if (cancelled) return;
        const j = response.job;
        onUpdateWizard({ jobId: j.jobId });
        setJob(j);
        if (j.state === "succeeded" || j.state === "failed" || j.state === "canceled") {
          // Server returned terminal state directly; the polling effect won't add anything.
          // Stash the full result so we can render the failure (or hand off on success).
          // The poll loop will still run once and produce the same outcome — that's fine.
        }
      } catch (err) {
        if (cancelled) return;
        setError(err);
      } finally {
        if (!cancelled) setSubmitting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryCount]);

  // Heartbeat counter while we're waiting on the POST so the UI shows progress.
  useEffect(() => {
    if (!submitting) return undefined;
    setSubmitElapsed(0);
    const t = window.setInterval(() => setSubmitElapsed((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [submitting]);

  // Poll job status. Stays on this screen on failure so the operator can see the error.
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
          setTerminalResult(result);
          // Clear jobId so a manual retry starts fresh, but keep the result on screen.
          onUpdateWizard({ jobId: null });
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
  const failedStep = terminalResult ? findFailedStep(terminalResult.job.steps) : null;
  const terminalError = terminalResult?.error ?? failedStep?.error ?? null;

  const onTryAgain = () => {
    startedRef.current = false;
    setRetryCount((n) => n + 1);
  };

  return html`
    <${WizardShell}
      stepIndex=${7}
      title=${terminalResult ? "Install failed" : "Installing"}
      subtitle=${terminalResult
        ? "The install couldn't finish. See the failed step below."
        : "Hang tight — this typically takes 2–5 minutes."}
      showBack=${false}
      showNext=${false}
    >
      ${error ? html`<${ErrorBanner} error=${error} />` : null}

      ${submitting && !job
        ? html`
            <div class="alert alert--info">
              Submitting install request… ${submitElapsed > 0 ? `${submitElapsed}s` : ""}
              <br />
              <span class="dim">
                The server runs each step synchronously, so this request stays open until the
                install finishes (or fails). You'll see step-by-step results below as soon as the
                response arrives.
              </span>
            </div>
          `
        : null}

      ${terminalResult
        ? html`
            <div class="alert alert--error">
              <strong>Install failed at:</strong>
              ${" "}${failedStep?.label ?? "an early step"}
              ${terminalError
                ? html`<br /><code>${terminalError.code}</code>: ${terminalError.message}`
                : null}
            </div>
          `
        : null}

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
                      <span>
                        ${step.label}
                        ${step.error
                          ? html`<br /><span class="dim">
                              <code>${step.error.code}</code>: ${step.error.message}
                            </span>`
                          : null}
                      </span>
                      <span class=${`badge badge--${step.state}`}>${step.state}</span>
                    </li>
                  `,
                )}
              </ul>
            </details>
          `
        : null}

      ${terminalResult
        ? html`
            <div class="wizard-step__nav">
              <button class="btn btn--secondary" type="button" onClick=${onBackToReview}>
                Back to review
              </button>
              <button class="btn" type="button" onClick=${onTryAgain}>Try again</button>
            </div>
          `
        : null}
    <//>
  `;
};
