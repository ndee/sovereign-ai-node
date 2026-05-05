import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useEffect, useState } from "../../vendor/preact-hooks.module.js";

import { apiGet, apiPost } from "../../api.js";
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

// Fallback LAN publicBaseUrl when host-info hasn't loaded yet (or returned no
// IPs). The Caddy IP-cert covers any IP the operator types in later, and the
// homeserver domain still drives MXIDs/server name; this hostname URL just
// fails to load in the browser until DNS/CA are set up. The fetch in
// useEffect normally replaces this before the operator gets here.
const LAN_FALLBACK_PUBLIC_BASE_URL = "https://matrix.lan.local";

const buildPresets = (lanIPv4) => {
  const lanIp = Array.isArray(lanIPv4) && lanIPv4.length > 0 ? lanIPv4[0] : null;
  const lanPublicBaseUrl = lanIp ? `https://${lanIp}/` : LAN_FALLBACK_PUBLIC_BASE_URL;
  return {
    // Public defaults are intentionally empty — the operator owns the real domain.
    public: { homeserverDomain: "", publicBaseUrl: "" },
    lan: { homeserverDomain: "matrix.lan.local", publicBaseUrl: lanPublicBaseUrl },
    dev: { homeserverDomain: "matrix.local.test", publicBaseUrl: "http://127.0.0.1:8008" },
  };
};

// Recognize all historical LAN preset URLs so we don't refuse to overwrite a
// stale persisted value when host-info finally arrives. Includes the
// hostname-based default and any IP-based URL.
const isKnownLanPublicBaseUrl = (value) => {
  if (typeof value !== "string") return false;
  if (value === LAN_FALLBACK_PUBLIC_BASE_URL) return true;
  return /^https:\/\/\d{1,3}(\.\d{1,3}){3}\/?$/.test(value);
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
    certificate for the homeserver domain <em>and</em> this node's LAN IP. You can reach the
    homeserver at <code>https://&lt;node-LAN-IP&gt;/</code> right after install — DNS is
    optional. Each client device just needs to trust the Caddy CA once.
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
  const [lanIPv4, setLanIPv4] = useState(null);

  const activeModeId = m.deployMode ?? "public";
  const presets = buildPresets(lanIPv4);

  // Fetch the host's LAN IPs once on mount so the Local LAN preset can default
  // publicBaseUrl to https://<IP>/ — the Caddy local-CA cert covers IPs.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await apiGet("/api/setup-ui/host-info");
        if (cancelled) return;
        setLanIPv4(Array.isArray(result?.lanIPv4) ? result.lanIPv4 : []);
      } catch {
        if (cancelled) return;
        setLanIPv4([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Once host-info arrives, refresh a stale persisted LAN publicBaseUrl
  // (e.g. matrix.lan.local from an earlier session) to the IP-based default.
  useEffect(() => {
    if (lanIPv4 === null) return;
    if (activeModeId !== "lan") return;
    const preset = buildPresets(lanIPv4).lan;
    if (m.publicBaseUrl === preset.publicBaseUrl) return;
    if (!isKnownLanPublicBaseUrl(m.publicBaseUrl)) return;
    onUpdateSection("matrix", { publicBaseUrl: preset.publicBaseUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanIPv4, activeModeId]);

  const onSelectMode = (mode) => {
    const preset = presets[mode.id] ?? {};
    const allPresets = Object.values(presets);
    onUpdateSection("matrix", {
      deployMode: mode.id,
      tlsMode: mode.tlsMode,
      // Only prefill URL/domain when blank or matches a known preset, so we don't
      // clobber values the operator has typed.
      homeserverDomain:
        m.homeserverDomain && !allPresets.some((p) => p.homeserverDomain === m.homeserverDomain)
          ? m.homeserverDomain
          : preset.homeserverDomain,
      publicBaseUrl:
        m.publicBaseUrl &&
        !allPresets.some((p) => p.publicBaseUrl === m.publicBaseUrl) &&
        !(mode.id === "lan" && isKnownLanPublicBaseUrl(m.publicBaseUrl))
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
      ${activeModeId === "public"
        ? html`
            <div class="btn-row">
              <button
                class="btn btn--secondary"
                type="button"
                onClick=${runTest}
                disabled=${!canTest || busy}
              >
                ${busy ? "Testing…" : "Test connection"}
              </button>
              <span class="dim" style="align-self: center;">
                Optional. Only useful if a homeserver is already running at this URL.
              </span>
            </div>
          `
        : html`
            <p class="dim" style="font-size: 0.85rem;">
              No connection test for this mode — the bundled installer will create the
              homeserver during install.
            </p>
          `}
    <//>
  `;
};
