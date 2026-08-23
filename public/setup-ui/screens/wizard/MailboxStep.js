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
          protocol: i.protocol === "pop3" ? "pop3" : "imap",
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
      subtitle="Mail Sentinel watches one mailbox over IMAP or POP3 and surfaces important incoming signals in Matrix."
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
                  ? `Mailbox connection looks good — ${testResult.host}:${testResult.port} (${
                      testResult.tls ? "TLS" : "plain"
                    }).`
                  : "Mailbox connection failed. Re-check host, port, TLS, email address / username and password."}
              </div>
              ${testResult.error
                ? html`<p class="muted">${testResult.error.message ?? testResult.error.code}</p>`
                : null}
            `
          : null}
      `}
    >
      <${Field}
        label="Protocol"
        hint="IMAP is recommended. POP3 is read-only too, has no folders, and Mail Sentinel keeps its own message index for it."
      >
        <select
          class="input"
          value=${i.protocol === "pop3" ? "pop3" : "imap"}
          onChange=${(event) => {
            const protocol = event.target.value === "pop3" ? "pop3" : "imap";
            const defaultPort = protocol === "pop3" ? 995 : 993;
            const wasDefault = i.port === 993 || i.port === 995;
            onUpdateSection("imap", { protocol, ...(wasDefault ? { port: defaultPort } : {}) });
          }}
        >
          <option value="imap">IMAP</option>
          <option value="pop3">POP3</option>
        </select>
      <//>
      <${Field} label="Host">
        <${TextInput}
          value=${i.host}
          onInput=${(value) => onUpdateSection("imap", { host: value })}
          placeholder=${i.protocol === "pop3" ? "pop.example.com" : "imap.example.com"}
        />
      <//>
      <div class="row">
        <${Field} label="Port">
          <${NumberInput}
            value=${i.port}
            min=${1}
            max=${65535}
            onInput=${(value) => onUpdateSection("imap", { port: value ?? (i.protocol === "pop3" ? 995 : 993) })}
          />
        <//>
        <${Field} label="TLS">
          <${Checkbox}
            checked=${i.tls === true}
            onInput=${(value) => onUpdateSection("imap", { tls: value })}
            label=${i.protocol === "pop3" ? "Use TLS (POP3S)" : "Use TLS (IMAPS)"}
          />
        <//>
      </div>
      <${Field}
        label="Email address / username"
        hint="Usually your full email address, depending on your mail provider."
      >
        <${TextInput}
          value=${i.username}
          onInput=${(value) => onUpdateSection("imap", { username: value })}
          placeholder="alerts@example.com"
        />
      <//>
      <${Field}
        label="Password"
        hint="An app password is recommended. It is sent to your node during setup and written to the node's managed secret store."
      >
        <${TextInput}
          value=${secrets.imapPassword}
          onInput=${(value) => onUpdateSecret("imapPassword", value)}
          type="password"
        />
      <//>
      ${i.protocol === "pop3"
        ? null
        : html`
            <${Field}
              label="Folder"
              hint="Defaults to INBOX. Change only if you want Mail Sentinel to watch a different folder."
            >
              <${TextInput}
                value=${i.mailbox}
                onInput=${(value) => onUpdateSection("imap", { mailbox: value })}
                placeholder="INBOX"
              />
            <//>
          `}
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
