import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useState } from "../../vendor/preact-hooks.module.js";

import { apiPost } from "../../api.js";
import { CheckList } from "../../components/CheckList.js";
import { WizardShell } from "../../components/WizardShell.js";
import { Checkbox, ErrorBanner, Field, TextInput } from "../../forms.js";

const html = htm.bind(h);

const DEPLOY_MODES = [
  {
    id: "public",
    title: "Public site",
    summary: "Real domain, real TLS, reachable from the internet.",
    tlsMode: "auto",
  },
  {
    id: "lan",
    title: "Local LAN",
    summary: "HTTPS on your network using a local CA you trust on each device.",
    tlsMode: "internal",
  },
  {
    id: "dev",
    title: "Local dev",
    summary: "No TLS, only this machine. Fastest way to try it out.",
    tlsMode: "local-dev",
  },
];

const PRESETS = {
  // Public defaults are intentionally empty — the operator owns the real domain.
  public: { homeserverDomain: "", publicBaseUrl: "" },
  lan: { homeserverDomain: "matrix.lan.local", publicBaseUrl: "https://matrix.lan.local" },
  dev: { homeserverDomain: "matrix.local.test", publicBaseUrl: "http://127.0.0.1:8008" },
};

const ModeCard = ({ mode, active, onSelect }) => html`
  <button
    type="button"
    class=${`mode-card ${active ? "mode-card--active" : ""}`}
    onClick=${() => onSelect(mode)}
  >
    <span class="mode-card__title">${mode.title}</span>
    <span class="mode-card__summary">${mode.summary}</span>
  </button>
`;

const PublicGuidance = () => html`
  <div class="alert alert--info">
    <strong>Before you continue, make sure your router/firewall is set up:</strong>
    <ul class="bullet-list" style="margin-top: 8px;">
      <li>DNS: your homeserver domain (e.g. <code>matrix.example.com</code>) resolves to this machine's public IP.</li>
      <li>Port <code>80</code> open to this machine — used once for the TLS certificate challenge.</li>
      <li>Port <code>443</code> open to this machine — Element clients connect here.</li>
      <li>If you enable federation below: also open port <code>8448</code>.</li>
    </ul>
    <span class="dim">If you don't have a domain or open ports, pick <strong>Local LAN</strong> or <strong>Local dev</strong> instead.</span>
  </div>
`;

const LanGuidance = () => html`
  <div class="alert alert--info">
    The bundled reverse proxy will run a local certificate authority and issue itself an HTTPS
    certificate for the homeserver domain you pick. You'll be asked to trust that CA on each
    Element client device after install.
  </div>
`;

const DevGuidance = () => html`
  <div class="alert alert--info">
    Plain HTTP on <code>127.0.0.1:8008</code>. Only reachable from this machine. Good for trying
    the wizard end-to-end without DNS, certificates, or a real homeserver.
  </div>
`;

export const MatrixStep = ({ wizardState, onUpdateSection, onBack, onNext, secrets, onUpdateSecret }) => {
  const m = wizardState.matrix;
  const op = wizardState.operator;
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);

  const activeModeId = m.deployMode ?? "public";

  const onSelectMode = (mode) => {
    const preset = PRESETS[mode.id] ?? {};
    onUpdateSection("matrix", {
      deployMode: mode.id,
      tlsMode: mode.tlsMode,
      // Only prefill URL/domain when blank or matches a known preset, so we don't
      // clobber values the operator has typed.
      homeserverDomain:
        m.homeserverDomain && !Object.values(PRESETS).some((p) => p.homeserverDomain === m.homeserverDomain)
          ? m.homeserverDomain
          : preset.homeserverDomain,
      publicBaseUrl:
        m.publicBaseUrl && !Object.values(PRESETS).some((p) => p.publicBaseUrl === m.publicBaseUrl)
          ? m.publicBaseUrl
          : preset.publicBaseUrl,
    });
    setTestResult(null);
  };

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
      <h3 style="text-transform: none; letter-spacing: 0; margin-bottom: 12px;">
        How will operators reach Matrix?
      </h3>
      <div class="mode-cards">
        ${DEPLOY_MODES.map(
          (mode) => html`
            <${ModeCard}
              mode=${mode}
              active=${activeModeId === mode.id}
              onSelect=${onSelectMode}
            />
          `,
        )}
      </div>
      ${activeModeId === "public" ? html`<${PublicGuidance} />` : null}
      ${activeModeId === "lan" ? html`<${LanGuidance} />` : null}
      ${activeModeId === "dev" ? html`<${DevGuidance} />` : null}

      <${Field}
        label="Public base URL"
        hint=${activeModeId === "dev"
          ? "Filled in for you. Only this machine can reach it."
          : "The URL operators will use to reach Matrix from the outside, e.g. https://matrix.example.com."}
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
      ${activeModeId !== "dev"
        ? html`
            <${Field} label="Federation">
              <${Checkbox}
                checked=${m.federationEnabled === true}
                onInput=${(value) => onUpdateSection("matrix", { federationEnabled: value })}
                label="Allow federation with other homeservers (off is the default and safer for personal nodes)"
              />
            <//>
          `
        : null}
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
