import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useEffect, useState } from "../../vendor/preact-hooks.module.js";

import { apiPost } from "../../api.js";
import { CheckList } from "../../components/CheckList.js";
import { WizardShell } from "../../components/WizardShell.js";
import { ErrorBanner } from "../../forms.js";

const html = htm.bind(h);

const TONE = {
  pass: "ok",
  warn: "warn",
  fail: "fail",
};

export const Preflight = ({ wizardState, onUpdateWizard, onBack, onNext }) => {
  const cached = wizardState.preflight;
  const [result, setResult] = useState(cached?.result ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiPost("/api/install/preflight", {});
      setResult(response);
      onUpdateWizard({
        preflight: { result: response, ranAt: new Date().toISOString() },
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (result === null) {
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overall = result?.overall;
  const canProceed = overall === "pass" || overall === "warn";
  const tone = overall ? TONE[overall] : "pending";

  return html`
    <${WizardShell}
      stepIndex=${1}
      title="Preflight checks"
      subtitle="A quick look at your machine. Most warnings are safe to continue past."
      onBack=${onBack}
      onNext=${onNext}
      nextDisabled=${!canProceed || busy}
      nextLabel="Continue"
      nextBusy=${busy}
      extra=${html`
        ${error ? html`<${ErrorBanner} error=${error} />` : null}
        ${result === null && !busy
          ? null
          : html`
              <div class="alert alert--${tone}">
                ${busy
                  ? "Running preflight checks…"
                  : overall === "pass"
                    ? "All checks passed."
                    : overall === "warn"
                      ? "Some checks reported warnings. You can continue, but read them first."
                      : "Some checks failed. Resolve the items below before continuing."}
              </div>
            `}
        ${result
          ? html`
              <${CheckList} checks=${result.checks} />
              ${result.recommendedActions && result.recommendedActions.length > 0
                ? html`
                    <h3>Recommended actions</h3>
                    <ul class="bullet-list">
                      ${result.recommendedActions.map((a) => html`<li>${a}</li>`)}
                    </ul>
                  `
                : null}
              <div class="btn-row">
                <button class="btn btn--secondary" type="button" onClick=${run} disabled=${busy}>
                  ${busy ? "Re-running…" : "Re-run preflight"}
                </button>
              </div>
            `
          : null}
      `}
    />
  `;
};
