import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useState } from "../../vendor/preact-hooks.module.js";

import { apiPost } from "../../api.js";
import { WizardShell } from "../../components/WizardShell.js";
import { Checkbox, ErrorBanner, Field, NumberInput, TextInput } from "../../forms.js";

const html = htm.bind(h);

export const MailboxStep = ({ wizardState, onUpdateSection, onBack, onNext, secrets, onUpdateSecret }) => {
  const i = wizardState.imap;
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);

  const formValid =
    i.host.trim().length > 0 &&
    i.username.trim().length > 0 &&
    secrets.imapPassword.length > 0 &&
    Number.isInteger(i.port) &&
    i.port > 0 &&
    i.port <= 65535;

  const canContinue = formValid;

  const runTest = async () => {
    if (!formValid) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const response = await apiPost("/api/install/test-imap", {
        imap: {
          host: i.host.trim(),
          port: i.port,
          tls: i.tls === true,
          username: i.username.trim(),
          password: secrets.imapPassword,
          ...(i.mailbox && i.mailbox.trim().length > 0 ? { mailbox: i.mailbox.trim() } : {}),
        },
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
      stepIndex=${3}
      title="Mailbox connection"
      subtitle="Mail Sentinel watches a mailbox over IMAP and triages incoming mail in Matrix."
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
                  ? `Mailbox auth ok on ${testResult.host}:${testResult.port} (${
                      testResult.tls ? "TLS" : "plain"
                    }).`
                  : "Mailbox connection failed. Re-check host, port, TLS, and credentials."}
              </div>
              ${testResult.error
                ? html`<p class="muted">${testResult.error.message ?? testResult.error.code}</p>`
                : null}
            `
          : null}
      `}
    >
      <${Field} label="Host">
        <${TextInput}
          value=${i.host}
          onInput=${(value) => onUpdateSection("imap", { host: value })}
          placeholder="imap.example.com"
        />
      <//>
      <div class="row">
        <${Field} label="Port">
          <${NumberInput}
            value=${i.port}
            onInput=${(value) => onUpdateSection("imap", { port: value ?? 993 })}
          />
        <//>
        <${Field} label="TLS">
          <${Checkbox}
            checked=${i.tls === true}
            onInput=${(value) => onUpdateSection("imap", { tls: value })}
            label="Use TLS (IMAPS)"
          />
        <//>
      </div>
      <${Field} label="Username">
        <${TextInput}
          value=${i.username}
          onInput=${(value) => onUpdateSection("imap", { username: value })}
          placeholder="alerts@example.com"
        />
      <//>
      <${Field}
        label="Password"
        hint="App password recommended. Stored only in the node's managed secret store, never in your browser."
      >
        <${TextInput}
          value=${secrets.imapPassword}
          onInput=${(value) => onUpdateSecret("imapPassword", value)}
          type="password"
        />
      <//>
      <${Field} label="Folder">
        <${TextInput}
          value=${i.mailbox}
          onInput=${(value) => onUpdateSection("imap", { mailbox: value })}
          placeholder="INBOX"
        />
      <//>
      <div class="btn-row">
        <button
          class="btn btn--secondary"
          type="button"
          onClick=${runTest}
          disabled=${!formValid || busy}
        >
          ${busy ? "Testing…" : "Test connection"}
        </button>
      </div>
    <//>
  `;
};
