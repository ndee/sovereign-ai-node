import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";

import { WizardShell } from "../../components/WizardShell.js";
import { Field, TextInput } from "../../forms.js";

const html = htm.bind(h);

export const ProviderStep = ({ wizardState, onUpdateSection, onBack, onNext, secrets, onUpdateSecret }) => {
  const o = wizardState.openrouter;
  const canContinue = secrets.openrouterApiKey.length > 0;

  return html`
    <${WizardShell}
      stepIndex=${4}
      title="LLM provider"
      subtitle="Mail Sentinel currently uses OpenRouter as the supported LLM provider in open core."
      onBack=${onBack}
      onNext=${onNext}
      nextDisabled=${!canContinue}
      nextLabel="Continue"
    >
      <${Field}
        label="OpenRouter API key"
        hint="Required. Sent to your node during setup and written to its managed secret store."
      >
        <${TextInput}
          value=${secrets.openrouterApiKey}
          onInput=${(value) => onUpdateSecret("openrouterApiKey", value)}
          type="password"
          placeholder="sk-or-…"
        />
      <//>
      <${Field}
        label="Initial default model"
        hint="This is only the initial default. You can change it later from the admin console."
      >
        <${TextInput}
          value=${o.model}
          onInput=${(value) => onUpdateSection("openrouter", { model: value })}
          placeholder="qwen/qwen3.5-9b"
        />
      <//>
      <div class="alert alert--info">
        The key is validated server-side when install starts. An invalid key will surface as a
        clear error on the install step, with a way back here to fix it.
      </div>
    <//>
  `;
};
