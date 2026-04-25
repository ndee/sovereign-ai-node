import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";

import { WizardShell } from "../../components/WizardShell.js";
import { summarizeRequest } from "./state.js";

const html = htm.bind(h);

export const ReviewStep = ({ wizardState, secrets, onBack, onNext }) => {
  const rows = summarizeRequest(wizardState);
  const secretsOk =
    secrets.operatorPassword.length >= 8 &&
    secrets.imapPassword.length > 0 &&
    secrets.openrouterApiKey.length > 0;

  return html`
    <${WizardShell}
      stepIndex=${6}
      title="Review and install"
      subtitle="Last look before we configure your node. The install runs locally on this machine."
      onBack=${onBack}
      onNext=${onNext}
      nextDisabled=${!secretsOk}
      nextLabel="Start install"
    >
      <dl class="kv">
        ${rows.map(
          (row) => html`
            <dt>${row.label}</dt>
            <dd>${row.value}</dd>
          `,
        )}
      </dl>
      ${secretsOk
        ? html`
            <div class="alert alert--info">
              Secrets are kept in this browser tab only and submitted once when you start the
              install. The node writes them into its managed secret store and the browser never
              persists them.
            </div>
          `
        : html`
            <div class="alert alert--warn">
              One or more secrets are missing. Go back and fill in the operator password, mailbox
              password, and OpenRouter API key.
            </div>
          `}
    <//>
  `;
};
