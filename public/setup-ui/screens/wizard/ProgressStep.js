import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useEffect, useRef, useState } from "../../vendor/preact-hooks.module.js";

import { apiGet, apiPost } from "../../api.js";
import { WizardShell } from "../../components/WizardShell.js";
import { CopyButton, ErrorBanner } from "../../forms.js";
import { buildInstallRequest } from "./state.js";

const html = htm.bind(h);

// Group raw installer step IDs into product-level phases the operator sees on
// the main progress list. Detailed step IDs stay accessible in the "Step
// detail" disclosure. Internal framework names (OpenClaw etc.) are kept out of
// the primary phase labels.
const PHASE_OF = (stepId) => {
  if (stepId === "preflight") return "Preparing runtime";
  if (stepId === "openclaw_bootstrap_cli" || stepId === "openclaw_bundled_plugin_tools") {
    return "Installing runtime backend";
  }
  if (stepId === "imap_validate") return "Connecting mailbox";
  if (stepId === "relay_enroll") return "__relay__"; // suppressed unless relay was opted in
  if (
    stepId === "matrix_provision" ||
    stepId === "matrix_bootstrap_accounts" ||
    stepId === "matrix_bootstrap_room"
  ) {
    return "Setting up Matrix";
  }
  if (
    stepId === "openclaw_gateway_service_install" ||
    stepId === "openclaw_configure" ||
    stepId === "bots_configure"
  ) {
    return "Activating components";
  }
  if (stepId === "mail_sentinel_scan_timer" || stepId === "mail_sentinel_register") {
    return "Activating Mail Sentinel";
  }
  if (stepId === "smoke_checks" || stepId === "test_alert") return "Finalizing node";
  return "Installing";
};

const TERMINAL_STATES = new Set(["succeeded", "skipped", "warned", "failed", "canceled"]);

// In open core, relay is opt-in and not part of the default install. The
// installer still emits a relay_enroll step that no-ops when relay isn't
// configured — hide that phase from the progress rollup unless the step
// actually did real work or failed. We detect "real work" by looking at the
// step's state (skipped means no-op).
const groupSteps = (steps) => {
  const phases = new Map();
  for (const step of steps) {
    const phase = PHASE_OF(step.id);
    if (phase === "__relay__") {
      // Only surface a relay phase if the step actually ran or failed.
      if (step.state === "skipped" || step.state === "pending") continue;
      const visiblePhase = "Connecting relay";
      if (!phases.has(visiblePhase)) {
        phases.set(visiblePhase, { phase: visiblePhase, steps: [] });
      }
      phases.get(visiblePhase).steps.push(step);
      continue;
    }
    if (!phases.has(phase)) {
      phases.set(phase, { phase, steps: [] });
    }
    phases.get(phase).steps.push(step);
  }
  return Array.from(phases.values()).map((entry) => {
    const states = entry.steps.map((s) => s.state);
    let state;
    if (states.some((s) => s === "failed")) {
      state = "failed";
    } else if (states.some((s) => s === "canceled")) {
      state = "canceled";
    } else if (states.some((s) => s === "running")) {
      state = "running";
    } else if (states.every((s) => TERMINAL_STATES.has(s))) {
      // All sub-steps reached a terminal state — pick the highest-signal one.
      if (states.some((s) => s === "warned")) state = "warned";
      else if (states.every((s) => s === "skipped")) state = "skipped";
      else state = "succeeded";
    } else if (states.some((s) => TERMINAL_STATES.has(s))) {
      // Mixed: some sub-steps already terminal, others still pending — show running.
      state = "running";
    } else {
      state = "pending";
    }
    return { ...entry, state };
  });
};

const PHASE_TONE = {
  pending: "pending",
  running: "running",
  succeeded: "ok",
  failed: "fail",
  canceled: "fail",
  warned: "warn",
  skipped: "pending",
};

const findFailedStep = (steps) => steps?.find((s) => s.state === "failed") ?? null;

// Translate a failed installer step into a calm, human summary plus a
// suggested next action. Returns { summary, suggestion } — both strings.
// summary stays short; suggestion is one actionable sentence. Raw error
// codes/messages remain available below as the verbatim "Raw error".
const humanizeFailure = (failedStep, terminalError) => {
  const code = terminalError?.code ?? failedStep?.error?.code ?? "";
  const message = terminalError?.message ?? failedStep?.error?.message ?? "";
  const stepLabel = failedStep?.label ?? "an early step";

  // Permission / EPERM / EACCES: usually means the installer wasn't run with
  // enough privilege, or a previous run left files owned by a different user.
  if (/EPERM|EACCES|permission denied/i.test(`${code} ${message}`)) {
    return {
      summary: `${stepLabel} failed because the installer could not write to a required path on this machine.`,
      suggestion:
        "Re-run install with sudo/root privileges on the target machine. If a previous run left files owned by another user, you may need to remove or chown them first.",
    };
  }
  // IMAP / mailbox issues
  if (failedStep?.id === "imap_validate" || /IMAP/i.test(code)) {
    return {
      summary: `${stepLabel} failed — the mailbox connection didn't authenticate.`,
      suggestion:
        "Re-check the mailbox host, username, app password, and whether the host is reachable from this machine. Then go back to the Mailbox step and Test connection again.",
    };
  }
  // OpenRouter / provider issues
  if (/OPENROUTER|provider|invalid.*key/i.test(`${code} ${message}`)) {
    return {
      summary: `${stepLabel} failed — the LLM provider key was not accepted.`,
      suggestion:
        "Re-check your OpenRouter key, then go back to the Provider step and re-enter it.",
    };
  }
  // Matrix / homeserver issues
  if (failedStep?.id?.startsWith("matrix_") || /matrix|homeserver/i.test(`${code} ${message}`)) {
    return {
      summary: `${stepLabel} failed while preparing your Matrix homeserver.`,
      suggestion:
        "If you're on Local LAN, confirm port 443 is free. If you're on Public, confirm DNS, port 80, and port 443 are reachable from the public internet.",
    };
  }
  // Generic
  return {
    summary: `${stepLabel} could not finish.`,
    suggestion:
      "Open Step detail below for the full step list and the raw error. Try again once you have addressed the cause.",
  };
};

// Detect the schema-validation error returned by POST /api/install/run when
// the request body fails contract validation (e.g. missing OpenRouter key).
// Surfaced as a calmer "configuration incomplete" UI rather than a raw
// API_ERROR banner.
const validationProviderHints = (err) => {
  const detail = err?.detail ?? err;
  const message = detail?.message ?? "";
  const lowered = message.toLowerCase();
  if (lowered.includes("openrouter") && lowered.includes("required")) {
    return {
      title: "Provider configuration incomplete",
      body: "Your OpenRouter key is missing or was not submitted correctly. Return to the Provider step and enter it again.",
    };
  }
  return null;
};

export const ProgressStep = ({
  wizardState,
  secrets,
  onUpdateWizard,
  onBackToReview,
  onBackToProvider,
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
        // The job we're polling may have been wiped server-side (state
        // reset, log rotation, etc.). Clear the stale jobId so the wizard
        // doesn't loop on it and the operator can hit "Try again" or go
        // back to review.
        const code = err?.detail?.code ?? err?.code;
        if (code === "INSTALL_JOB_NOT_FOUND") {
          onUpdateWizard({ jobId: null });
          setTerminalResult(null);
          setError({
            detail: {
              code: "INSTALL_JOB_NOT_FOUND",
              message:
                "This install job no longer exists on the node (likely because the node state was reset). Go back to Review and start a new install.",
            },
          });
          return;
        }
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
  const humanFailure =
    terminalResult && (failedStep || terminalError)
      ? humanizeFailure(failedStep, terminalError)
      : null;

  // Validation/contract errors arrive *before* a job exists. Surface them as a
  // calm "configuration incomplete" UI rather than a raw API_ERROR banner.
  const validationHint = error && !job ? validationProviderHints(error) : null;

  const deployMode = wizardState?.matrix?.deployMode ?? "public";
  const installSubtitle =
    deployMode === "public"
      ? "Your node is being prepared locally. The bundled reverse proxy may take a few minutes to obtain a public TLS cert."
      : "Your node is being prepared locally. This can take a few minutes depending on machine speed.";

  const onTryAgain = () => {
    startedRef.current = false;
    setRetryCount((n) => n + 1);
  };

  // Build a single multi-line string the operator can copy when reporting an
  // issue or pasting into a prompt. Includes the failed step, the raw error
  // code/message, and the full step list with statuses.
  const rawErrorCopy = () => {
    if (!terminalResult) return "";
    const lines = [];
    lines.push(`Install failed at: ${failedStep?.label ?? "(unknown step)"}`);
    if (terminalError) {
      lines.push(`${terminalError.code ?? "ERROR"}: ${terminalError.message ?? "(no message)"}`);
    }
    lines.push("");
    lines.push("Step list:");
    for (const s of terminalResult.job.steps ?? []) {
      lines.push(`- [${s.state}] ${s.id}${s.label ? ` — ${s.label}` : ""}`);
      if (s.error) lines.push(`    ${s.error.code ?? "ERROR"}: ${s.error.message ?? ""}`);
    }
    return lines.join("\n");
  };

  return html`
    <${WizardShell}
      stepIndex=${7}
      title=${validationHint
        ? validationHint.title
        : terminalResult
          ? "Install stopped before completion"
          : "Installing"}
      subtitle=${validationHint
        ? validationHint.body
        : terminalResult
          ? "We saved enough state for you to retry. See the failed step below for what stopped it."
          : installSubtitle}
      showBack=${false}
      showNext=${false}
    >
      ${error && !validationHint ? html`<${ErrorBanner} error=${error} />` : null}

      ${validationHint
        ? html`
            <div class="wizard-step__nav">
              <button class="btn btn--secondary" type="button" onClick=${onBackToReview}>
                Back to review
              </button>
              ${onBackToProvider
                ? html`
                    <button class="btn" type="button" onClick=${onBackToProvider}>
                      Back to provider
                    </button>
                  `
                : null}
            </div>
            <details class="phase-detail">
              <summary>Technical detail</summary>
              <p class="muted">
                <code>${error?.detail?.code ?? error?.code ?? "API_ERROR"}</code>:
                ${" "}${error?.detail?.message ?? error?.message ?? ""}
              </p>
            </details>
          `
        : null}

      ${!validationHint && submitting && !job
        ? html`
            <div class="alert alert--info">
              Submitting install request… ${submitElapsed > 0 ? `${submitElapsed}s` : ""}
              <br />
              <span class="dim">
                The server runs each step in sequence, so this request stays open until the
                install finishes (or stops). Progress will appear below as soon as the response
                arrives.
              </span>
            </div>
          `
        : null}

      ${terminalResult && humanFailure
        ? html`
            <div class="alert alert--error">
              <strong>${humanFailure.summary}</strong>
              <p style="margin: 8px 0 0;">${humanFailure.suggestion}</p>
              ${terminalError
                ? html`
                    <p class="dim" style="margin: 8px 0 0; font-size: 0.85rem;">
                      Raw error: <code>${terminalError.code}</code>: ${terminalError.message}
                    </p>
                  `
                : null}
              <div class="btn-row" style="margin-top: 12px;">
                <${CopyButton} value=${rawErrorCopy()} label="Copy raw error" />
              </div>
            </div>
          `
        : null}

      ${!validationHint && phases.length > 0
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

      ${!validationHint && job
        ? html`
            <details class="phase-detail" open=${terminalResult ? true : undefined}>
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
