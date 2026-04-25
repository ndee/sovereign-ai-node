import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";
import { useState } from "../vendor/preact-hooks.module.js";

import { apiPost } from "../api.js";
import {
  Checkbox,
  ErrorBanner,
  Field,
  NumberInput,
  SubmitButton,
  TextInput,
} from "../forms.js";

const html = htm.bind(h);

const Result = ({ result }) => {
  if (!result) return null;
  return html`
    <div class="card" style="margin-top: 18px;">
      <h3>Reconfigure result</h3>
      <p>
        Target: <code>${result.target}</code>. Changed:
        <code>${result.changed.length === 0 ? "(nothing)" : result.changed.join(", ")}</code>.
      </p>
      ${result.restartRequiredServices.length > 0
        ? html`
            <p class="muted">
              Restart required:
              <code>${result.restartRequiredServices.join(", ")}</code>
            </p>
          `
        : null}
      ${result.validation.length > 0
        ? html`
            <ul class="steps">
              ${result.validation.map(
                (check) => html`
                  <li>
                    <span>${check.name}<br /><span class="dim">${check.message ?? ""}</span></span>
                    <span class=${`badge badge--${check.status}`}>${check.status}</span>
                  </li>
                `,
              )}
            </ul>
          `
        : null}
    </div>
  `;
};

const ImapForm = () => {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(993);
  const [tls, setTls] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [mailbox, setMailbox] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const imap = {
        host,
        port,
        tls,
        username,
        ...(password.length > 0 ? { password } : {}),
        ...(secretRef.length > 0 ? { secretRef } : {}),
        ...(mailbox.length > 0 ? { mailbox } : {}),
      };
      const response = await apiPost("/api/reconfigure/imap", { imap });
      setResult(response);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <form onSubmit=${submit}>
      <${ErrorBanner} error=${error} />
      <${Field} label="Host">
        <${TextInput} value=${host} onInput=${setHost} placeholder="imap.example.com" />
      <//>
      <${Field} label="Port">
        <${NumberInput} value=${port} onInput=${(value) => setPort(value ?? 993)} />
      <//>
      <${Field} label="TLS">
        <${Checkbox} checked=${tls} onInput=${setTls} label="Use TLS (IMAPS)" />
      <//>
      <${Field} label="Username">
        <${TextInput} value=${username} onInput=${setUsername} />
      <//>
      <${Field}
        label="Password (optional)"
        hint="Provide one of password or secretRef. The password is written to the managed secret store."
      >
        <${TextInput} value=${password} onInput=${setPassword} type="password" />
      <//>
      <${Field}
        label="Secret ref (optional)"
        hint="Path-like reference to an existing managed secret, e.g. file:/etc/sovereign-node/secrets/imap-password."
      >
        <${TextInput} value=${secretRef} onInput=${setSecretRef} />
      <//>
      <${Field} label="Mailbox (optional)">
        <${TextInput} value=${mailbox} onInput=${setMailbox} placeholder="INBOX" />
      <//>
      <div class="btn-row">
        <${SubmitButton} busy=${busy}>Apply IMAP changes<//>
      </div>
      <${Result} result=${result} />
    </form>
  `;
};

const MatrixForm = () => {
  const [homeserverDomain, setHomeserverDomain] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [federationEnabled, setFederationEnabled] = useState(false);
  const [operatorUsername, setOperatorUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const matrix = {
        ...(homeserverDomain.length > 0 ? { homeserverDomain } : {}),
        ...(publicBaseUrl.length > 0 ? { publicBaseUrl } : {}),
        federationEnabled,
      };
      const operator = operatorUsername.length > 0 ? { username: operatorUsername } : undefined;
      const body = {
        ...(Object.keys(matrix).length > 0 ? { matrix } : {}),
        ...(operator !== undefined ? { operator } : {}),
      };
      const response = await apiPost("/api/reconfigure/matrix", body);
      setResult(response);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <form onSubmit=${submit}>
      <${ErrorBanner} error=${error} />
      <${Field} label="Homeserver domain">
        <${TextInput}
          value=${homeserverDomain}
          onInput=${setHomeserverDomain}
          placeholder="matrix.example.com"
        />
      <//>
      <${Field} label="Public base URL">
        <${TextInput}
          value=${publicBaseUrl}
          onInput=${setPublicBaseUrl}
          placeholder="https://matrix.example.com"
        />
      <//>
      <${Field} label="Federation">
        <${Checkbox}
          checked=${federationEnabled}
          onInput=${setFederationEnabled}
          label="Enable federation"
        />
      <//>
      <${Field} label="Operator username (optional)">
        <${TextInput} value=${operatorUsername} onInput=${setOperatorUsername} />
      <//>
      <div class="btn-row">
        <${SubmitButton} busy=${busy}>Apply Matrix changes<//>
      </div>
      <${Result} result=${result} />
    </form>
  `;
};

const OpenrouterForm = () => {
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const openrouter = {
        ...(model.length > 0 ? { model } : {}),
        ...(apiKey.length > 0 ? { apiKey } : {}),
        ...(secretRef.length > 0 ? { secretRef } : {}),
      };
      const response = await apiPost("/api/reconfigure/openrouter", { openrouter });
      setResult(response);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <form onSubmit=${submit}>
      <${ErrorBanner} error=${error} />
      <p class="muted">Provide at least one of model, apiKey, or secretRef.</p>
      <${Field} label="Model (optional)">
        <${TextInput} value=${model} onInput=${setModel} placeholder="openai/gpt-4o-mini" />
      <//>
      <${Field}
        label="API key (optional)"
        hint="If provided, written to the managed secret store. Mutually exclusive with secretRef."
      >
        <${TextInput} value=${apiKey} onInput=${setApiKey} type="password" />
      <//>
      <${Field} label="Secret ref (optional)">
        <${TextInput} value=${secretRef} onInput=${setSecretRef} />
      <//>
      <div class="btn-row">
        <${SubmitButton} busy=${busy}>Apply OpenRouter changes<//>
      </div>
      <${Result} result=${result} />
    </form>
  `;
};

const TARGETS = {
  imap: { title: "Reconfigure IMAP", component: ImapForm },
  matrix: { title: "Reconfigure Matrix", component: MatrixForm },
  openrouter: { title: "Reconfigure OpenRouter", component: OpenrouterForm },
};

export const Reconfigure = ({ target }) => {
  const entry = TARGETS[target] ?? TARGETS.imap;
  const Form = entry.component;
  return html`
    <section class="hero">
      <h1>${entry.title}</h1>
      <p>Apply changes to the running installation. Validation runs server-side.</p>
    </section>
    <section class="section">
      <div class="card">
        <${Form} />
      </div>
    </section>
  `;
};
