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
    summary: "Advanced: real domain, real TLS, reachable from the internet.",
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
    summary: "Plain HTTP on this machine only. Best for trying the full setup once.",
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
    <strong>Advanced path.</strong> Best for operators comfortable with DNS, ports, and
    router/firewall setup. Before you continue, confirm:
    <ul class="bullet-list" style="margin-top: 8px;">
      <li>Your domain resolves to this machine's public IP.</li>
      <li>Port <code>80</code> is open for the TLS certificate challenge.</li>
      <li>Port <code>443</code> is open for Matrix and Element traffic.</li>
      <li>If you enable federation below, port <code>8448</code> is also open.</li>
    </ul>
    <span class="dim">Don't have a domain or open ports? Pick <strong>Local LAN</strong> or <strong>Local dev</strong>.</span>
  </div>
`;

const LanGuidance = ({ lanIp }) => {
  const ipExample = lanIp ?? "<your-LAN-IP>";
  return html`
    <div class="alert alert--info">
      The bundled reverse proxy runs a local CA and issues a TLS cert that covers this node's
      LAN IP <em>and</em> any homeserver hostname you set below.
      <ul class="bullet-list" style="margin-top: 8px;">
        <li>
          <strong>Reach by IP immediately.</strong> ${" "}
          <code>${`https://${ipExample}/`}</code> works right after install.
        </li>
        <li>
          <strong>Optional friendly hostname.</strong> Add a router DNS rewrite or per-device
          <code>/etc/hosts</code> entry later if you'd rather use a name than an IP.
        </li>
        <li>
          <strong>Trust the local CA once per device.</strong> The Done page links to the
          download and shows per-OS import steps.
        </li>
      </ul>
      <span class="dim">
        Avoid <code>.local</code> hostnames if you have iOS/macOS clients — that suffix is
        mDNS-reserved and plain DNS overrides may be ignored.
      </span>
    </div>
  `;
};

const DevGuidance = () => html`
  <div class="alert alert--info">
    Best for trying the full setup on a single machine. Only this machine can reach the
    homeserver directly — there is no TLS and no LAN exposure. To use Element from a laptop,
    SSH-tunnel <code>8008</code> to your workstation. The bundled homeserver will be created
    during install; there is nothing to test yet.
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

  const lanIp = Array.isArray(lanIPv4) && lanIPv4.length > 0 ? lanIPv4[0] : null;

  // Mode-aware copy — keep the URL field a single conceptual field across all
  // modes, but adjust the helper so it makes sense per mode.
  const matrixUrlHint =
    activeModeId === "dev"
      ? "Filled automatically for local-only setup. Only this machine can reach it."
      : activeModeId === "lan"
        ? "How operators will reach Matrix on your LAN. Defaults to this node's IP — change to a hostname if you've set up DNS for it."
        : "The URL operators will use to reach Matrix from the internet, e.g. https://matrix.example.com.";

  return html`
    <${WizardShell}
      stepIndex=${2}
      title="Matrix control plane"
      subtitle="Choose how operators will reach Matrix after install."
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
      ${activeModeId === "lan" ? html`<${LanGuidance} lanIp=${lanIp} />` : null}
      ${activeModeId === "dev" ? html`<${DevGuidance} />` : null}

      <${Field} label="Matrix URL" hint=${matrixUrlHint}>
        <${TextInput}
          value=${m.publicBaseUrl}
          onInput=${(value) => onUpdateSection("matrix", { publicBaseUrl: value })}
          placeholder=${activeModeId === "lan" && lanIp
            ? `https://${lanIp}/`
            : "https://matrix.example.com"}
        />
      <//>
      <${Field}
        label="Homeserver domain"
        hint="The Matrix server name — the part after @user: in MXIDs. Often the same host as the URL above, without https://."
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
                label="Allow federation with other homeservers (off is the safer default for personal nodes)"
              />
            <//>
          `
        : null}
      <${Field}
        label="Alert room"
        hint="Default Matrix room for Mail Sentinel and node-operator alerts. Created during install."
      >
        <${TextInput}
          value=${m.alertRoomName}
          onInput=${(value) => onUpdateSection("matrix", { alertRoomName: value })}
          placeholder="Sovereign Alerts"
        />
      <//>
      <${Field}
        label="Operator username"
        hint="A local Matrix account created during install. Just the localpart, e.g. 'operator'."
      >
        <${TextInput}
          value=${op.username}
          onInput=${(value) => onUpdateSection("operator", { username: value })}
          placeholder="operator"
        />
      <//>
      <${Field}
        label="Operator password"
        hint="Created on your bundled homeserver during install. Minimum 8 characters."
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
                Optional. Useful if a homeserver is already running at this URL.
              </span>
            </div>
          `
        : null}
    <//>
  `;
};
