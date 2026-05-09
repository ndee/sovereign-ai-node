import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useEffect, useState } from "../../vendor/preact-hooks.module.js";

import { apiGet, apiPost } from "../../api.js";
import { WizardShell } from "../../components/WizardShell.js";
import { CopyButton, ErrorBanner } from "../../forms.js";

const html = htm.bind(h);

const isOutstanding = (state) => {
  if (state === null) return false;
  if (state.consumedAt !== undefined) return false;
  if (Date.parse(state.expiresAt) <= Date.now()) return false;
  if (state.failedAttempts >= state.maxAttempts) return false;
  return true;
};

const inferOperatorUserId = (wizardState) => {
  const localpart = wizardState?.operator?.username?.trim();
  const domain = wizardState?.matrix?.homeserverDomain?.trim();
  if (!localpart || !domain) return null;
  if (localpart.startsWith("@") && localpart.includes(":")) return localpart;
  return `@${localpart}:${domain}`;
};

// Build https://app.element.io/#/login?hs_url=...&login_hint=... — a hosted
// Element Web client prefilled with the operator's homeserver and username.
// Mirrors buildElementWebLoginLink() in src/system/matrix-onboarding-page.ts.
const buildElementWebLoginLink = (publicBaseUrl, operatorUserId) => {
  if (!publicBaseUrl) return null;
  const params = `hs_url=${encodeURIComponent(publicBaseUrl)}`;
  const hint =
    operatorUserId && operatorUserId !== "(operator)"
      ? `&login_hint=${encodeURIComponent(operatorUserId)}`
      : "";
  return `https://app.element.io/#/login?${params}${hint}`;
};

// Pull just the host (hostname or IP, no port) out of a URL string. Used to
// substitute the actual LAN IP into preconditions copy where we previously
// printed the literal placeholder "<node-LAN-IP>". Returns null on parse
// failure so callers can fall back gracefully.
const hostnameFromUrl = (url) => {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
};

// Project slug used by docker-compose for the bundled-Matrix stack.
// Mirrors slugifyProjectName() in src/system/matrix.ts.
const slugifyProjectName = (domain) =>
  (domain ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
  "matrix";

const HandoffBlock = ({ result, wizardState }) => {
  const fromResult = result?.nextSteps;
  const homeserverUrl = fromResult?.elementHomeserverUrl ?? wizardState?.matrix?.publicBaseUrl;
  const operatorUserId =
    fromResult?.operatorUsername ?? inferOperatorUserId(wizardState) ?? "(operator)";
  const roomName = fromResult?.roomName ?? wizardState?.matrix?.alertRoomName ?? "Sovereign Alerts";
  const deployMode = wizardState?.matrix?.deployMode ?? "public";
  // Open Element makes sense whenever the homeserver is reachable from the
  // operator's current device. Public has DNS + a real cert; Local LAN has
  // a Caddy IP-cert that the operator's browser already trusts (or will,
  // per the preconditions card below). Local dev binds 127.0.0.1 only, so
  // there's nothing for app.element.io to talk to.
  const showOpenElement = deployMode === "public" || deployMode === "lan";
  const tunnelOnly = deployMode === "dev";
  const elementWebUrl = showOpenElement ? buildElementWebLoginLink(homeserverUrl, operatorUserId) : null;

  return html`
    ${homeserverUrl
      ? html`
          ${elementWebUrl
            ? html`
                <a
                  class="btn btn--xl"
                  href=${elementWebUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open Element →
                </a>
              `
            : null}
          <dl class="kv kv--compact">
            <dt>Operator</dt>
            <dd>${operatorUserId}</dd>
            <dt>Alert room</dt>
            <dd>${roomName}</dd>
            <dt>Homeserver</dt>
            <dd>${homeserverUrl}</dd>
          </dl>
        `
      : null}
    ${tunnelOnly
      ? html`
          <div class="alert alert--info">
            <strong>Local dev mode.</strong> The homeserver is bound to
            <code>http://127.0.0.1:8008</code> on the node host and isn't reachable from
            another machine. To connect from your laptop, open an SSH tunnel:
            <code class="code-block">${"ssh -L 8008:127.0.0.1:8008 <node-host>"}</code>
            Then open <code>http://127.0.0.1:8008</code> in your browser.
          </div>
        `
      : null}
    ${result?.nextSteps?.notes && result.nextSteps.notes.length > 0
      ? html`
          <ul class="bullet-list">
            ${result.nextSteps.notes.map((note) => html`<li>${note}</li>`)}
          </ul>
        `
      : null}
  `;
};

const LanPreconditionsCard = ({ wizardState }) => {
  if (wizardState?.matrix?.deployMode !== "lan") return null;
  const domain = wizardState?.matrix?.homeserverDomain ?? "matrix.lan.local";
  const publicBaseUrl = wizardState?.matrix?.publicBaseUrl ?? "";
  const host = hostnameFromUrl(publicBaseUrl) ?? "<node-LAN-IP>";
  const baseHttps = `https://${host}`;
  const caUrl = `${baseHttps}/downloads/caddy-root-ca.crt`;

  return html`
    <div class="card">
      <h3>Before this homeserver works on your LAN</h3>
      <p class="muted">
        You picked <strong>Local LAN</strong>. The reverse proxy is up and Caddy issued a TLS
        cert that includes this node's LAN IP, so you can reach it at ${" "}
        <code>${`${baseHttps}/`}</code> from any device on your network — once that device
        trusts the Caddy CA.
      </p>
      <ol class="bullet-list">
        <li>
          <strong>Trust the Caddy CA.</strong> The reverse proxy serves the root cert. Download
          it on each device — either click ${" "}
          <a href=${caUrl} target="_blank" rel="noreferrer noopener">this link</a> ${" "}
          (you may have to dismiss a one-time browser warning, since the device doesn't trust
          the CA yet), or run on the device:
          <code class="code-block">${`curl -k ${caUrl} -o caddy-root-ca.crt`}</code>
          Then import:
          <span class="dim">
            macOS: open in Keychain → System → drag-drop, set "Always Trust".<br />
            Linux: copy to <code>/usr/local/share/ca-certificates/</code> → run ${" "}
            <code>sudo update-ca-certificates</code>.<br />
            Windows: <code>certmgr.msc</code> → Trusted Root Certification Authorities →
            Import.<br />
            iOS/Android: AirDrop / share the file → Settings prompts for cert install + trust.
          </span>
        </li>
        <li>
          <strong>Port 443.</strong> The reverse proxy listens on <code>:443</code>. Verify
          from another device with
          <code class="code-block">${`curl -k ${baseHttps}/`}</code>
          and adjust LAN or host firewall rules if blocked.
        </li>
        <li>
          <strong>Optional — DNS.</strong> If you'd rather use the friendly name ${" "}
          <code>${domain}</code> instead of the IP, add a router DNS rewrite or a per-device
          <code>/etc/hosts</code> entry:
          <code class="code-block">${`${host} ${domain}`}</code>
          <span class="dim">
            Not required — the cert is valid for the IP, so the IP works on its own. Note that
            <code>.local</code> is mDNS-reserved on macOS/iOS and plain DNS overrides for it
            may be ignored there.
          </span>
        </li>
      </ol>
    </div>
  `;
};

export const SuccessStep = ({ result, wizardState, onManageNode }) => {
  const [issued, setIssued] = useState(null);
  const [issueError, setIssueError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const state = await apiGet("/api/onboarding/state");
        if (cancelled) return;
        if (isOutstanding(state)) {
          setBusy(false);
          return;
        }
        const response = await apiPost("/api/onboarding/issue", {});
        if (cancelled) return;
        setIssued(response);
      } catch (err) {
        if (!cancelled) setIssueError(err);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reissue = async () => {
    setBusy(true);
    setIssueError(null);
    try {
      const response = await apiPost("/api/onboarding/issue", {});
      setIssued(response);
    } catch (err) {
      setIssueError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`
    <${WizardShell}
      stepIndex=${8}
      title="Your node is ready"
      subtitle="From here, the rest of operations happens in Matrix."
      showBack=${false}
      showNext=${false}
    >
      <${HandoffBlock} result=${result} wizardState=${wizardState} />

      ${issueError ? html`<${ErrorBanner} error=${issueError} />` : null}
      ${busy && issued === null
        ? html`<p class="muted">Issuing your one-time onboarding code…</p>`
        : null}
      ${issued
        ? html`
            <h3>One-time onboarding code</h3>
            <p class="muted">
              Use this code to sign in from Element. It expires ${issued.expiresAt}.
            </p>
            <code class="code-block code-block--lg">${issued.code}</code>
            <div class="btn-row">
              <${CopyButton} value=${issued.code} label="Copy code" />
              <${CopyButton} value=${issued.onboardingLink} label="Copy link" />
              <a
                class="btn btn--secondary"
                href=${issued.onboardingLink}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open onboarding link
              </a>
            </div>
          `
        : html`
            ${!busy
              ? html`
                  <div class="btn-row">
                    <button class="btn" type="button" onClick=${reissue} disabled=${busy}>
                      Issue onboarding code
                    </button>
                  </div>
                `
              : null}
          `}

      <${LanPreconditionsCard} wizardState=${wizardState} />

      <div class="alert alert--info">
        Sign in to Element with the code, accept the invite to your alert room, and close this
        tab when you're done. You can come back here later for credential changes.
      </div>

      <p class="dim wizard-step__exit">
        Need to manage this node from the browser? <a href="#/admin/status" onClick=${onManageNode}>Open the admin console.</a>
      </p>
    <//>
  `;
};
