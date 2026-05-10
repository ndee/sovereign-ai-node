import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";

import { WizardShell } from "../../components/WizardShell.js";

const html = htm.bind(h);

const DEFAULT_MODULES = [
  {
    id: "mail-sentinel",
    name: "Mail Sentinel",
    summary: "Watches one mailbox and posts important signals in Matrix.",
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
    title="Installed components"
    subtitle="These components are included in the current open-core setup."
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
            <span class="badge badge--ok">included</span>
          </li>
        `,
      )}
    </ul>
    <p class="dim" style="font-size: 0.85rem;">
      Both run locally on your node. Choosing components à la carte is not part of the
      open-core flow today.
    </p>
  <//>
`;
