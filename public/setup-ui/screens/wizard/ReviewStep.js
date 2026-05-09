import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";

import { WizardShell } from "../../components/WizardShell.js";
import { summarizeRequest } from "./state.js";

const html = htm.bind(h);

export const ReviewStep = ({ wizardState, secrets, onBack, onNext }) => {
  const sections = summarizeRequest(wizardState);
  const secretsOk =
    secrets.operatorPassword.length >= 8 &&
    secrets.imapPassword.length > 0 &&
    secrets.openrouterApiKey.length > 0;

  // Mask = "yes, set" or "missing", never the secret itself.
  const secretRows = [
    {
      label: "Operator password",
      value: secrets.operatorPassword.length >= 8 ? "set" : "missing",
    },
    {
      label: "Mailbox password",
      value: secrets.imapPassword.length > 0 ? "set" : "missing",
    },
    {
      label: "OpenRouter API key",
      value: secrets.openrouterApiKey.length > 0 ? "set" : "missing",
    },
  ];

  return html`
    <${WizardShell}
      stepIndex=${6}
      title="Review and install"
      subtitle="Last look before we configure your node. The install runs locally on this machine."
      onBack=${onBack}
      onNext=${onNext}
      nextDisabled=${!secretsOk}
      nextLabel="Install locally"
    >
      ${sections.map(
        (section) => html`
          <h3 class="review-section__title">${section.title}</h3>
          <dl class="kv">
            ${section.rows.map(
              (row) => html`
                <dt>${row.label}</dt>
                <dd>${row.value}</dd>
              `,
            )}
          </dl>
        `,
      )}
      <h3 class="review-section__title">Secrets</h3>
      <dl class="kv">
        ${secretRows.map(
          (row) => html`
            <dt>${row.label}</dt>
            <dd>${row.value}</dd>
          `,
        )}
      </dl>
      ${secretsOk
        ? html`
            <div class="alert alert--info">
              Secrets entered here are submitted only when install starts. They are then
              written to the node's managed secret store. The browser never persists them.
            </div>
          `
        : html`
            <div class="alert alert--warn">
              One or more secrets are missing. Go back and fill in the operator password,
              mailbox password, and OpenRouter API key.
            </div>
          `}
    <//>
  `;
};
