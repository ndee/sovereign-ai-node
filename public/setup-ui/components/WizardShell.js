import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";

import { Stepper } from "./Stepper.js";

const html = htm.bind(h);

export const STEP_LABELS = [
  "Welcome",
  "Preflight",
  "Matrix",
  "Mailbox",
  "Provider",
  "Modules",
  "Review",
  "Install",
  "Done",
];

export const WizardShell = ({
  stepIndex,
  title,
  subtitle,
  children,
  onBack,
  onNext,
  nextLabel,
  nextBusy,
  nextDisabled,
  showBack = true,
  showNext = true,
  extra,
}) => html`
  <div class="wizard-shell">
    <header class="wizard-shell__header">
      <div class="wizard-shell__brand">
        Sovereign AI Node
        <small>Local setup</small>
      </div>
      <${Stepper} steps=${STEP_LABELS} currentIndex=${stepIndex} />
    </header>
    <main class="wizard-shell__main">
      <section class="wizard-step">
        <h1>${title}</h1>
        ${subtitle ? html`<p class="wizard-step__subtitle">${subtitle}</p>` : null}
        <div class="wizard-step__body">${children}</div>
        ${extra ?? null}
        ${showBack || showNext
          ? html`
              <div class="wizard-step__nav">
                ${showBack
                  ? html`
                      <button
                        class="btn btn--secondary"
                        type="button"
                        onClick=${onBack}
                        disabled=${nextBusy}
                      >
                        Back
                      </button>
                    `
                  : html`<span></span>`}
                ${showNext
                  ? html`
                      <button
                        class="btn"
                        type="button"
                        onClick=${onNext}
                        disabled=${nextBusy || nextDisabled}
                      >
                        ${nextBusy ? "Working…" : (nextLabel ?? "Continue")}
                      </button>
                    `
                  : null}
              </div>
            `
          : null}
      </section>
    </main>
  </div>
`;
