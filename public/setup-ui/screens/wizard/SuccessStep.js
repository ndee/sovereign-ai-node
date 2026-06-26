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

// Decide how to surface a failure of POST /api/onboarding/issue. Some errors
// are *expected and temporary* on the Done page right after install — the
// runtime config is still being written, so CONFIG_NOT_FOUND can flicker
// briefly. Render those as a neutral "still completing" info block, not as
// a red failure contradicting the success heading. Truly fatal errors stay
// red.
const classifyIssueError = (err) => {
  if (!err) return null;
  const code = err?.detail?.code ?? err?.code;
  const message = err?.detail?.message ?? err?.message ?? "";
  if (code === "CONFIG_NOT_FOUND" || /CONFIG_NOT_FOUND|runtime config/i.test(message)) {
    return {
      tone: "warn",
      // The node *is* installed; the runtime is just still writing the last
      // bits of config. We say so plainly instead of "Node finalizing",
      // which read as both done-and-not-done at once.
      body: "Final runtime setup is still completing. Onboarding will be available in a moment.",
    };
  }
  // Anything else stays as a regular red ErrorBanner.
  return null;
};

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
  const host = hostnameFromUrl(publicBaseUrl) ?? "your-LAN-IP";
  const baseHttps = `https://${host}`;
  const caUrl = `${baseHttps}/downloads/caddy-root-ca.crt`;

  return html`
    <div class="card">
      <h3>Connecting devices to your LAN homeserver</h3>
      <p class="muted">
        Caddy issued a local TLS cert for <code>${baseHttps}/</code>. Each device that
        wants to reach Matrix needs to trust the local CA once.
      </p>

      <h4 class="precondition__title">1. Trust the local CA</h4>
      <p class="muted">
        Download the root cert on each device. The first time, your browser will warn that
        the page isn't trusted yet — that's expected; accept the warning to download.
      </p>
      <p>
        <a href=${caUrl} target="_blank" rel="noreferrer noopener">
          Download caddy-root-ca.crt
        </a>
      </p>
      <p class="muted">Or run on a headless device:</p>
      <code class="code-block">${`curl -k ${caUrl} -o caddy-root-ca.crt`}</code>
      <p class="dim" style="margin-top: 8px;">
        macOS: open in Keychain → System → drag-drop, set "Always Trust".<br />
        Linux: copy to <code>/usr/local/share/ca-certificates/</code> → run ${" "}
        <code>sudo update-ca-certificates</code>.<br />
        Windows: <code>certmgr.msc</code> → Trusted Root Certification Authorities → Import.<br />
        iOS/Android: AirDrop or share the file → Settings prompts to install and trust it.
      </p>

      <h4 class="precondition__title">2. Verify port 443</h4>
      <p class="muted">
        From another device on the LAN, confirm the reverse proxy is reachable. Adjust
        LAN or host firewall rules if blocked.
      </p>
      <code class="code-block">${`curl -k ${baseHttps}/`}</code>

      <h4 class="precondition__title">3. Optional — friendly hostname</h4>
      <p class="muted">
        If you'd rather type a name than an IP, add a router DNS rewrite or a per-device
        <code>/etc/hosts</code> entry. Not required — the IP works on its own.
      </p>
      <code class="code-block">${`${host} ${domain}`}</code>
      ${domain.endsWith(".local")
        ? html`
            <p class="dim" style="margin-top: 8px;">
              Heads up: <code>.local</code> is mDNS-reserved on macOS/iOS — plain DNS
              overrides for it may be ignored on those devices.
            </p>
          `
        : null}
    </div>
  `;
};

// Per-mode wait ceiling for the onboarding page coming online. relay-passthrough
// nodes terminate their own TLS via deSEC DNS-01, which can take minutes to
// issue; every other mode is reachable within seconds. Mirrors the CLI
// `onboarding ready` deadlines.
const READINESS_DEADLINE_MS = (mode) => (mode === "relay-passthrough" ? 12 * 60_000 : 60_000);
const READINESS_POLL_INTERVAL_MS = 2_000;

export const SuccessStep = ({ result, wizardState, onManageNode }) => {
  const [issued, setIssued] = useState(null);
  const [issueError, setIssueError] = useState(null);
  const [busy, setBusy] = useState(false);
  // null = still checking; true once the onboarding page is reachable OR we gave
  // up waiting (readyTimedOut). The issue effect is gated on this so we never
  // reveal a URL/QR that doesn't load yet.
  const [pageReady, setPageReady] = useState(false);
  const [readyTimedOut, setReadyTimedOut] = useState(false);

  // Gate 1: wait for the public onboarding page to actually serve before
  // revealing anything. Polls /api/onboarding/ready; tolerates transient
  // errors and config-not-found (keeps polling). Reveals-with-warning on
  // timeout so the operator is never stranded on a spinner.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const startedAt = Date.now();
    // The deadline can only grow as we learn the real mode. The first ticks
    // often report mode "direct" with reason "config-not-found" (config still
    // writing); we must NOT lock the short 60s deadline from that and then time
    // out before a relay-passthrough cert finishes issuing. So we recompute the
    // ceiling each tick from the longest deadline any real reading has implied.
    let deadlineMs = READINESS_DEADLINE_MS();
    const tick = async () => {
      try {
        const readiness = await apiGet("/api/onboarding/ready");
        if (cancelled) return;
        if (readiness?.ready) {
          setPageReady(true);
          return;
        }
        // config-not-found carries a placeholder mode; ignore it for sizing.
        if (readiness?.mode && readiness.reason !== "config-not-found") {
          deadlineMs = Math.max(deadlineMs, READINESS_DEADLINE_MS(readiness.mode));
        }
      } catch {
        // Transient (e.g. API momentarily unavailable). Keep polling.
        if (cancelled) return;
      }
      if (Date.now() - startedAt >= deadlineMs) {
        setReadyTimedOut(true);
        setPageReady(true);
        return;
      }
      timer = window.setTimeout(tick, READINESS_POLL_INTERVAL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // Gate 2: once the page is ready (or we timed out waiting), issue/reveal the
  // one-time code exactly as before.
  useEffect(() => {
    if (!pageReady) return undefined;
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
  }, [pageReady]);

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

  const deployMode = wizardState?.matrix?.deployMode ?? "public";
  const benignIssue = classifyIssueError(issueError);
  // Title and subtitle are mode-aware. We deliberately do NOT say "Your node
  // is ready" while a fatal banner is in play — see classifyIssueError above.
  const title =
    deployMode === "dev"
      ? "Local dev install completed"
      : "Your node is installed";
  const subtitle =
    deployMode === "dev"
      ? "Local dev mode — only this machine can reach Matrix directly. Daily operation moves to Matrix once you connect a client."
      : "From here, daily operation moves to Matrix. This web UI stays available for setup changes and admin tasks.";

  return html`
    <${WizardShell}
      stepIndex=${8}
      title=${title}
      subtitle=${subtitle}
      showBack=${false}
      showNext=${false}
    >
      <${HandoffBlock} result=${result} wizardState=${wizardState} />

      ${!pageReady
        ? html`<div class="alert alert--info">
            Bringing your onboarding page online… on a public node this can take a
            few minutes while the node obtains its certificate.
          </div>`
        : null}
      ${readyTimedOut
        ? html`<div class="alert alert--warn">
            Your onboarding page may take a few more minutes to come online. The link
            and code below are valid now — if the page doesn't load yet, wait a moment
            and refresh.
          </div>`
        : null}

      ${issueError && benignIssue
        ? html`<div class="alert alert--warn">${benignIssue.body}</div>`
        : issueError
          ? html`<${ErrorBanner} error=${issueError} />`
          : null}
      ${pageReady && busy && issued === null
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
            ${pageReady && !busy
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
        tab when you're done. Setup changes and admin tasks remain here.
      </div>

      <p class="dim wizard-step__exit">
        Need to manage this node from the browser? <a href="#/admin/status" onClick=${onManageNode}>Open the admin console.</a>
      </p>
    <//>
  `;
};
