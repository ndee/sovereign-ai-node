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
      subtitle="The agents reach an LLM through OpenRouter. You can change this later."
      onBack=${onBack}
      onNext=${onNext}
      nextDisabled=${!canContinue}
      nextLabel="Continue"
    >
      <${Field}
        label="OpenRouter API key"
        hint="Your key is written to the node's managed secret store, never to your browser. Required to start."
      >
        <${TextInput}
          value=${secrets.openrouterApiKey}
          onInput=${(value) => onUpdateSecret("openrouterApiKey", value)}
          type="password"
          placeholder="sk-or-…"
        />
      <//>
      <${Field}
        label="Default model"
        hint="A small, capable default. Change later from the admin console."
      >
        <${TextInput}
          value=${o.model}
          onInput=${(value) => onUpdateSection("openrouter", { model: value })}
          placeholder="qwen/qwen3.5-9b"
        />
      <//>
      <div class="alert alert--info">
        Validation runs server-side at install time. If the key is wrong, install will surface that
        in the progress step.
      </div>
    <//>
  `;
};
