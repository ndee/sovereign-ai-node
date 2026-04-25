import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useState } from "../../vendor/preact-hooks.module.js";

import { apiPost } from "../../api.js";
import { CheckList } from "../../components/CheckList.js";
import { WizardShell } from "../../components/WizardShell.js";
import { Checkbox, ErrorBanner, Field, TextInput } from "../../forms.js";

const html = htm.bind(h);

export const MatrixStep = ({ wizardState, onUpdateSection, onBack, onNext, secrets, onUpdateSecret }) => {
  const m = wizardState.matrix;
  const op = wizardState.operator;
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);

  const canTest = m.publicBaseUrl.trim().length > 0;
  const canContinue =
    m.homeserverDomain.trim().length > 0 &&
    m.publicBaseUrl.trim().length > 0 &&
    op.username.trim().length > 0 &&
    secrets.operatorPassword.length >= 8;

  const runTest = async () => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const response = await apiPost("/api/install/test-matrix", {
        publicBaseUrl: m.publicBaseUrl.trim(),
        federationEnabled: m.federationEnabled === true,
      });
      setTestResult(response);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <${WizardShell}
      stepIndex=${2}
      title="Matrix homeserver"
      subtitle="Matrix is your node's control plane. After install, you'll talk to the agents in Element."
      onBack=${onBack}
      onNext=${onNext}
      nextDisabled=${!canContinue || busy}
      nextLabel="Continue"
      nextBusy=${busy}
      extra=${html`
        ${error ? html`<${ErrorBanner} error=${error} />` : null}
        ${testResult
          ? html`
              <div class="alert alert--${testResult.ok ? "success" : "error"}">
                ${testResult.ok
                  ? `Matrix homeserver is reachable at ${testResult.homeserverUrl}.`
                  : "Matrix homeserver could not be reached. See the checks below."}
              </div>
              <${CheckList} checks=${testResult.checks} />
            `
          : null}
      `}
    >
      <${Field}
        label="Public base URL"
        hint="The URL operators will use to reach Matrix from the outside, e.g. https://matrix.example.com."
      >
        <${TextInput}
          value=${m.publicBaseUrl}
          onInput=${(value) => onUpdateSection("matrix", { publicBaseUrl: value })}
          placeholder="https://matrix.example.com"
        />
      <//>
      <${Field}
        label="Homeserver domain"
        hint="The Matrix domain part of user IDs (the bit after @user:). Often the same host as above without https://."
      >
        <${TextInput}
          value=${m.homeserverDomain}
          onInput=${(value) => onUpdateSection("matrix", { homeserverDomain: value })}
          placeholder="matrix.example.com"
        />
      <//>
      <${Field} label="Federation">
        <${Checkbox}
          checked=${m.federationEnabled === true}
          onInput=${(value) => onUpdateSection("matrix", { federationEnabled: value })}
          label="Allow federation with other homeservers (off is the default and safer for personal nodes)"
        />
      <//>
      <${Field}
        label="Alert room name"
        hint="A Matrix room created during install where Mail Sentinel and node-operator post. Defaults to 'Sovereign Alerts'."
      >
        <${TextInput}
          value=${m.alertRoomName}
          onInput=${(value) => onUpdateSection("matrix", { alertRoomName: value })}
          placeholder="Sovereign Alerts"
        />
      <//>
      <${Field}
        label="Operator username"
        hint="Your Matrix username on this homeserver. Just the localpart, e.g. 'operator'."
      >
        <${TextInput}
          value=${op.username}
          onInput=${(value) => onUpdateSection("operator", { username: value })}
          placeholder="operator"
        />
      <//>
      <${Field}
        label="Operator password"
        hint="Used to create your operator account on the bundled homeserver. Minimum 8 characters."
      >
        <${TextInput}
          value=${secrets.operatorPassword}
          onInput=${(value) => onUpdateSecret("operatorPassword", value)}
          type="password"
        />
      <//>
      <div class="btn-row">
        <button
          class="btn btn--secondary"
          type="button"
          onClick=${runTest}
          disabled=${!canTest || busy}
        >
          ${busy ? "Testing…" : "Test connection"}
        </button>
      </div>
    <//>
  `;
};
