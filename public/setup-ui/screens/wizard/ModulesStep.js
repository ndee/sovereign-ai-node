import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";

import { WizardShell } from "../../components/WizardShell.js";

const html = htm.bind(h);

const DEFAULT_MODULES = [
  {
    id: "mail-sentinel",
    name: "Mail Sentinel",
    summary: "Watches your mailbox and triages incoming mail in Matrix.",
  },
  {
    id: "node-operator",
    name: "node-operator",
    summary: "Chat-based control plane for your node, in Matrix.",
  },
];

export const ModulesStep = ({ onBack, onNext }) => html`
  <${WizardShell}
    stepIndex=${5}
    title="Modules"
    subtitle="The two core modules. Both are recommended and both run locally on your node."
    onBack=${onBack}
    onNext=${onNext}
    nextLabel="Continue"
  >
    <ul class="module-list">
      ${DEFAULT_MODULES.map(
        (mod) => html`
          <li class="module-list__item">
            <div>
              <h3 class="module-list__name">${mod.name}</h3>
              <p class="muted">${mod.summary}</p>
            </div>
            <span class="badge badge--ok">on</span>
          </li>
        `,
      )}
    </ul>
    <div class="alert alert--info">
      Customising the module list is coming later. For now both modules are installed by default.
    </div>
  <//>
`;
