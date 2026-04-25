import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";

import { WizardShell } from "../../components/WizardShell.js";

const html = htm.bind(h);

export const Welcome = ({ onNext }) => html`
  <${WizardShell}
    stepIndex=${0}
    title="Welcome to your Sovereign AI Node"
    subtitle="A calm, local-first setup. About 5–10 minutes from here to a working node."
    showBack=${false}
    nextLabel="Begin setup"
    onNext=${onNext}
  >
    <p>
      This setup runs entirely on your machine. Nothing is sent off-device until you connect
      Matrix. We'll guide you through six things, in order:
    </p>
    <ol class="bullet-list">
      <li>Confirm your machine is ready (Docker, disk, DNS, time).</li>
      <li>Point the node at a Matrix homeserver — the local control plane.</li>
      <li>Connect a mailbox so <strong>Mail Sentinel</strong> can watch it for you.</li>
      <li>Add an LLM provider key for the agents.</li>
      <li>Pick which modules to install (Mail Sentinel and node-operator are on by default).</li>
      <li>Review and start the install.</li>
    </ol>
    <p>
      When the install finishes, the rest of operations happens in
      <strong>Matrix</strong> — chat-based, audit-logged. You can come back here later for
      credential changes, but day-to-day, you'll talk to your node in Element.
    </p>
    <div class="alert alert--info">
      You can leave and come back. Form values you've entered are kept in this browser. Passwords
      and keys are never stored on disk by the browser.
    </div>
  <//>
`;
