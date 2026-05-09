import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";

import { WizardShell } from "../../components/WizardShell.js";

const html = htm.bind(h);

export const Welcome = ({ onNext }) => html`
  <${WizardShell}
    stepIndex=${0}
    title="Welcome to your Sovereign AI Node"
    subtitle="A calm, local-first setup for technical operators. About 5–15 minutes depending on your network mode and environment."
    showBack=${false}
    nextLabel="Begin setup"
    onNext=${onNext}
  >
    <p>
      This setup runs locally on your machine. External connections are only made for the
      services you configure in the next steps.
    </p>
    <ol class="bullet-list">
      <li>Check whether this machine is ready (privileges, ports, Docker, DNS, time).</li>
      <li>Choose how operators will reach <strong>Matrix</strong> — your control plane.</li>
      <li>Connect a mailbox for <strong>Mail Sentinel</strong>.</li>
      <li>Add an LLM provider key.</li>
      <li>Confirm the default components.</li>
      <li>Review and install locally.</li>
    </ol>
    <p>
      After install, day-to-day operation moves to <strong>Matrix</strong> — chat-based,
      audit-logged. This web UI stays available for setup changes and admin tasks.
    </p>
    <div class="alert alert--info">
      You can leave and come back. Form values you've entered are kept in this browser tab.
      Passwords and keys are not persisted by the browser.
    </div>
  <//>
`;
