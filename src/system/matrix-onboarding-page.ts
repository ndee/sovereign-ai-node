import { buildMatrixOnboardingUrl } from "../onboarding/bootstrap-code.js";

type BundledMatrixOnboardingMode = "auto" | "internal" | "relay";

export const renderOnboardingPage = (input: {
  publicBaseUrl: string;
  homeserverDomain: string;
  tlsMode: BundledMatrixOnboardingMode;
  onboardingPageUrl: string;
  onboardingQrSvg: string;
  alertRoomName?: string;
  alertRoomId?: string;
}): string => {
  const elementWebLink = buildElementWebLoginLink(input.publicBaseUrl);
  const elementAndroidLink = buildElementAndroidIntentLink(input.publicBaseUrl);
  const roomLink = input.alertRoomId ? buildElementWebRoomLink(input.alertRoomId) : "";
  const namedAlertRoom = input.alertRoomName?.trim() ?? "";
  const alertRoomName = namedAlertRoom || "alert room";
  const escapedAlertRoomName = escapeHtml(alertRoomName);
  const alertRoomLabel =
    namedAlertRoom.length > 0 ? `<code>${escapedAlertRoomName}</code>` : "the alert room";
  const alertRoomLinkTarget =
    namedAlertRoom.length > 0
      ? `the existing ${escapedAlertRoomName} room`
      : "the existing alert room";
  const caSection =
    input.tlsMode === "internal"
      ? [
          '<section class="card caution">',
          "  <h2>1. Install the Local CA</h2>",
          "  <p>This LAN-only setup uses Caddy&apos;s internal certificate authority. Install the CA on your phone before opening Element.</p>",
          '  <a class="button button-secondary" href="/downloads/caddy-root-ca.crt">Download CA Certificate</a>',
          '  <p class="meta">After download, trust this certificate in your device&apos;s settings. Native Android Matrix apps may still reject local CAs; Element Web in the browser is the reliable path.</p>',
          "</section>",
        ].join("\n")
      : "";
  const nativeAppHint =
    input.tlsMode === "internal"
      ? "If the native app still cannot reach the server, it is rejecting the local CA or local-network setup. In that case use the browser path above. Vanadium and Brave may behave differently, so the copy buttons below remain the fallback path."
      : "The Android app button prefills the homeserver using Element Classic&apos;s documented deep link. If the app still drops you into a generic login flow, use the copy buttons below and paste the exact values manually.";
  const botGuidanceSection = [
    '<section class="card">',
    "  <h2>After login: message the right bot</h2>",
    "  <ol>",
    "    <li>Use <strong>Node Operator</strong> for Sovereign Node status, installer health, and system operations.</li>",
    "    <li>Use <strong>Mail Sentinel</strong> to watch incoming mail, send important alerts, and accept quiet feedback after IMAP is configured.</li>",
    `    <li>Use ${alertRoomLabel} for notifications and hello messages from both bots.</li>`,
    "  </ol>",
    "</section>",
  ].join("\n");
  const roomSection = input.alertRoomId
    ? [
        '<section class="card">',
        "  <h2>After login: open the alert room</h2>",
        `  <p>After login, use this button to jump directly into ${alertRoomLinkTarget}.</p>`,
        '  <a class="button button-secondary" href="' +
          escapeHtml(roomLink) +
          '" target="_blank" rel="noreferrer">Open Alert Room in Element Web</a>',
        '  <p class="meta">If Element asks again, keep the same homeserver URL and session.</p>',
        "</section>",
      ].join("\n")
    : "";
  const copyStep = input.tlsMode === "internal" ? 2 : 1;
  const webStep = input.tlsMode === "internal" ? 3 : 2;
  const qrStep = input.tlsMode === "internal" ? 4 : 3;
  const signInStep = input.tlsMode === "internal" ? 5 : 4;
  const verifyStep = input.tlsMode === "internal" ? 6 : 5;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    "  <title>Sovereign Node Phone Setup</title>",
    "  <style>",
    "    :root { color-scheme: light; --bg: #0f172a; --panel: rgba(15, 23, 42, 0.84); --panel-2: rgba(30, 41, 59, 0.78); --text: #e2e8f0; --muted: #bfdbfe; --accent: #22c55e; --accent-2: #38bdf8; --warn: #f59e0b; }",
    "    * { box-sizing: border-box; }",
    '    body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at top, #1d4ed8 0%, #0f172a 42%, #020617 100%); color: var(--text); }',
    "    main { width: min(100%, 760px); margin: 0 auto; padding: 24px 16px 40px; }",
    "    .hero { padding: 24px; border-radius: 24px; background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(14, 116, 144, 0.15)), var(--panel); box-shadow: 0 24px 80px rgba(2, 6, 23, 0.45); }",
    "    .eyebrow { margin: 0 0 8px; font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }",
    "    h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.2rem); line-height: 1.05; }",
    "    p { line-height: 1.55; }",
    "    .stack { display: grid; gap: 16px; margin-top: 20px; }",
    "    .card { padding: 20px; border-radius: 20px; background: var(--panel-2); border: 1px solid rgba(148, 163, 184, 0.18); }",
    "    .caution { border-color: rgba(245, 158, 11, 0.35); background: linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(30, 41, 59, 0.85)); }",
    "    h2 { margin: 0 0 10px; font-size: 1.05rem; }",
    "    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 52px; width: 100%; padding: 14px 18px; border: 0; border-radius: 16px; text-decoration: none; font: inherit; font-weight: 700; cursor: pointer; color: #020617; background: linear-gradient(135deg, var(--accent), #86efac); }",
    "    .button-secondary { margin-top: 8px; color: var(--text); background: linear-gradient(135deg, rgba(56, 189, 248, 0.22), rgba(59, 130, 246, 0.28)); }",
    "    .qr-shell { display: grid; place-items: center; margin-top: 14px; padding: 18px; border-radius: 18px; background: rgba(255, 255, 255, 0.92); }",
    "    .qr-shell svg { width: min(100%, 280px); height: auto; }",
    "    code { display: block; margin-top: 10px; padding: 12px 14px; border-radius: 14px; background: rgba(2, 6, 23, 0.55); overflow-wrap: anywhere; color: #dbeafe; }",
    "    ol { margin: 10px 0 0; padding-left: 20px; }",
    "    li + li { margin-top: 8px; }",
    "    .meta { margin: 10px 0 0; font-size: 0.92rem; color: var(--muted); }",
    "    .field { display: grid; gap: 8px; margin-top: 12px; }",
    "    .field span { font-size: 0.92rem; color: var(--muted); }",
    "    .field input { width: 100%; min-height: 52px; border-radius: 14px; border: 1px solid rgba(148, 163, 184, 0.28); background: rgba(2, 6, 23, 0.55); color: var(--text); padding: 0 16px; font: inherit; letter-spacing: 0.12em; text-transform: uppercase; }",
    "    .button-row { display: grid; gap: 8px; margin-top: 12px; }",
    "    .hidden { display: none !important; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    '    <section class="hero">',
    '      <p class="eyebrow">Sovereign Node</p>',
    "      <h1>Connect your phone to Matrix</h1>",
    "      <p>Use this page on your phone to unlock a local Matrix invitation with the least manual typing.</p>",
    `      <code>Homeserver URL: ${escapeHtml(input.publicBaseUrl)}</code>`,
    '      <p class="meta">Local usernames on this node end with <code>:' +
      escapeHtml(input.homeserverDomain) +
      "</code>.</p>",
    "    </section>",
    '    <div class="stack">',
    caSection,
    '      <section class="card">',
    `        <h2>${String(copyStep)}. Quick copy and unlock</h2>`,
    "        <p>Copy the homeserver here. Unlock the username and password with a one-time code printed by the installer or generated later with <code>sudo sovereign-node onboarding issue</code>.</p>",
    '        <div class="button-row">',
    '          <button class="button button-secondary" type="button" onclick="copyHomeserverUrl(this)">Copy Server URL</button>',
    '          <button class="button button-secondary hidden" id="copyUsernameButton" type="button" onclick="copyUsername(this)">Copy Username</button>',
    "        </div>",
    '        <code id="revealedUsername" class="hidden"></code>',
    '        <label class="field" for="bootstrapCode">',
    "          <span>One-time onboarding code</span>",
    '          <input id="bootstrapCode" name="bootstrapCode" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH-IJKL">',
    "        </label>",
    '        <div class="button-row">',
    '          <button class="button" id="redeemButton" type="button" onclick="redeemCode(this)">Unlock Password</button>',
    '          <button class="button button-secondary hidden" id="copyPasswordButton" type="button" onclick="copyPassword(this)">Copy Password</button>',
    "        </div>",
    '        <p class="meta" id="passwordStatus">The username and password are not embedded in this page. The code works once, expires after the configured TTL, and must be reissued for later onboarding.</p>',
    "      </section>",
    '      <section class="card">',
    `        <h2>${String(webStep)}. Continue with Element Web</h2>`,
    "        <p>The button opens Element Web with your homeserver prefilled. Browser restrictions still prevent safe password injection into app.element.io, so you may still need to paste the password manually.</p>",
    '        <a class="button" id="elementWebLink" href="' +
      escapeHtml(elementWebLink) +
      '" rel="noreferrer">Connect via Element Web</a>',
    '        <a class="button button-secondary" id="elementAndroidLink" href="' +
      escapeHtml(elementAndroidLink) +
      '" rel="noreferrer">Open in Element Android App</a>',
    '        <p class="meta">If Element still shows the generic login screen, tap <strong>Edit</strong> in the homeserver field and paste the full URL exactly as shown above. Do not type only ' +
      escapeHtml(new URL(input.publicBaseUrl).host) +
      ".</p>",
    '        <p class="meta">The Android button uses Element Classic&apos;s documented <code>hs_url</code> deep link and explicitly targets the F-Droid package <code>im.vector.app</code>. It can prefill the homeserver, but not securely inject the password.</p>',
    '        <p class="meta" id="usernameHint">Unlock the invitation first if you need the exact username.</p>',
    `        <p class="meta">${nativeAppHint}</p>`,
    "      </section>",
    '      <section class="card">',
    `        <h2>${String(qrStep)}. Open this setup page on another device</h2>`,
    "        <p>Open this page on a laptop, then scan the QR code from your phone if you want to hand off setup between devices. If you already have a link with a <code>#code=...</code> fragment, opening it on your phone can prefill the code field without redeeming it yet.</p>",
    '        <div class="qr-shell">',
    input.onboardingQrSvg,
    "        </div>",
    `        <p class="meta">This QR points to ${escapeHtml(input.onboardingPageUrl)}</p>`,
    "      </section>",
    '      <section class="card">',
    `        <h2>${String(signInStep)}. Sign in</h2>`,
    "        <ol>",
    "          <li>Unlock the invitation from this page to reveal the exact username and password.</li>",
    "          <li>Copy the username and password into Element.</li>",
    "          <li>If Element asks for a homeserver again, paste the exact <code>https://</code> URL shown at the top of this page.</li>",
    "        </ol>",
    "      </section>",
    '      <section class="card">',
    `        <h2>${String(verifyStep)}. If Element asks to verify another device</h2>`,
    "        <ol>",
    "          <li>Tap <strong>Bestätigung nicht möglich?</strong>.</li>",
    "          <li>Continue without verification or without secure backup.</li>",
    `          <li>This is acceptable for ${alertRoomLabel} because it is not configured as an encrypted room.</li>`,
    "        </ol>",
    "      </section>",
    botGuidanceSection,
    roomSection,
    "    </div>",
    "  </main>",
    "  <script>",
    `    const homeserverUrl = ${JSON.stringify(input.publicBaseUrl)};`,
    "    let revealedUsername = '';",
    "    let revealedPassword = '';",
    "    async function copyHomeserverUrl(button) {",
    "      await copyValue(button, homeserverUrl);",
    "    }",
    "    async function copyUsername(button) {",
    "      if (!revealedUsername) {",
    "        const oldText = button.textContent;",
    "        button.textContent = 'Not available';",
    "        setTimeout(() => { button.textContent = oldText; }, 1800);",
    "        return;",
    "      }",
    "      await copyValue(button, revealedUsername);",
    "    }",
    "    async function redeemCode(button) {",
    "      const codeInput = document.getElementById('bootstrapCode');",
    "      const status = document.getElementById('passwordStatus');",
    "      const copyButton = document.getElementById('copyPasswordButton');",
    "      const copyUsernameButton = document.getElementById('copyUsernameButton');",
    "      const revealedUsernameCode = document.getElementById('revealedUsername');",
    "      const usernameHint = document.getElementById('usernameHint');",
    "      const code = typeof codeInput?.value === 'string' ? codeInput.value.trim() : '';",
    "      if (!code) {",
    "        status.textContent = 'Enter the one-time onboarding code from the installer output.';",
    "        return;",
    "      }",
    "      const previousText = button.textContent;",
    "      button.textContent = 'Unlocking...';",
    "      button.disabled = true;",
    "      try {",
    "        const response = await fetch('/onboard/api/redeem', {",
    "          method: 'POST',",
    "          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },",
    "          cache: 'no-store',",
    "          body: JSON.stringify({ code }),",
    "        });",
    "        const payload = await response.json().catch(() => ({}));",
    "        if (!response.ok) {",
    "          revealedUsername = '';",
    "          revealedPassword = '';",
    "          copyButton.classList.add('hidden');",
    "          copyUsernameButton.classList.add('hidden');",
    "          revealedUsernameCode.classList.add('hidden');",
    "          revealedUsernameCode.textContent = '';",
    "          usernameHint.textContent = 'Unlock the invitation first if you need the exact username.';",
    "          status.textContent = typeof payload.message === 'string' && payload.message.length > 0",
    "            ? payload.message + ' Ask the operator for a fresh code.'",
    "            : 'The one-time code could not be redeemed. Ask the operator for a fresh code.';",
    "          return;",
    "        }",
    "        revealedUsername = typeof payload.username === 'string' ? payload.username : '';",
    "        revealedPassword = typeof payload.password === 'string' ? payload.password : '';",
    "        if (!revealedUsername || !revealedPassword) {",
    "          throw new Error('Invitation details were missing from the onboarding response');",
    "        }",
    "        revealedUsernameCode.textContent = 'Username: ' + revealedUsername;",
    "        revealedUsernameCode.classList.remove('hidden');",
    "        copyUsernameButton.classList.remove('hidden');",
    "        copyButton.classList.remove('hidden');",
    "        usernameHint.textContent = 'The invitation username is now unlocked and can be copied below.';",
    "        updateLoginLinks(revealedUsername);",
    "        status.textContent = 'Username and password unlocked for this page session. Copy them now. After one successful password copy it is cleared from this page.';",
    "      } catch (error) {",
    "        revealedUsername = '';",
    "        revealedPassword = '';",
    "        copyButton.classList.add('hidden');",
    "        copyUsernameButton.classList.add('hidden');",
    "        revealedUsernameCode.classList.add('hidden');",
    "        revealedUsernameCode.textContent = '';",
    "        usernameHint.textContent = 'Unlock the invitation first if you need the exact username.';",
    "        status.textContent = error instanceof Error ? error.message : 'Unlock failed';",
    "      } finally {",
    "        button.disabled = false;",
    "        button.textContent = previousText;",
    "      }",
    "    }",
    "    async function copyPassword(button) {",
    "      const status = document.getElementById('passwordStatus');",
    "      const copyButton = document.getElementById('copyPasswordButton');",
    "      if (!revealedPassword) {",
    "        const oldText = button.textContent;",
    "        button.textContent = 'Not available';",
    "        setTimeout(() => { button.textContent = oldText; }, 1800);",
    "        return;",
    "      }",
    "      await copyValue(button, revealedPassword);",
    "      revealedPassword = '';",
    "      copyButton.classList.add('hidden');",
    "      status.textContent = 'Password copied. It has been cleared from this page. Ask the operator for a fresh code if you need to unlock it again.';",
    "    }",
    "    function updateLoginLinks(username) {",
    "      const webLink = document.getElementById('elementWebLink');",
    "      const androidLink = document.getElementById('elementAndroidLink');",
    "      if (webLink) {",
    "        webLink.href = buildElementWebLink(username);",
    "      }",
    "      if (androidLink) {",
    "        androidLink.href = buildElementAndroidLink(username);",
    "      }",
    "    }",
    "    function buildElementWebLink(username) {",
    "      const suffix = username ? '&login_hint=' + encodeURIComponent(username) : '';",
    "      return 'https://app.element.io/#/login?hs_url=' + encodeURIComponent(homeserverUrl) + suffix;",
    "    }",
    "    function buildElementAndroidLink(username) {",
    "      const suffix = username ? '&login_hint=' + encodeURIComponent(username) : '';",
    "      const fallbackUrl = 'https://mobile.element.io/?hs_url=' + encodeURIComponent(homeserverUrl) + suffix;",
    "      return 'intent://mobile.element.io/?hs_url=' + encodeURIComponent(homeserverUrl) + suffix",
    "        + '#Intent;scheme=https;package=im.vector.app;S.browser_fallback_url=' + encodeURIComponent(fallbackUrl) + ';end';",
    "    }",
    "    function readCodeFromLocation() {",
    "      const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';",
    "      const hashParams = new URLSearchParams(hash);",
    "      const queryParams = new URLSearchParams(window.location.search);",
    "      const fromHash = hashParams.get('code');",
    "      const fromQuery = queryParams.get('code');",
    "      return typeof fromHash === 'string' && fromHash.length > 0 ? fromHash",
    "        : typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery",
    "          : '';",
    "    }",
    "    function clearCodeFromLocation() {",
    "      if (!window.history?.replaceState) {",
    "        return;",
    "      }",
    "      const url = new URL(window.location.href);",
    "      url.hash = '';",
    "      url.searchParams.delete('code');",
    "      const search = url.searchParams.toString();",
    "      window.history.replaceState(null, '', url.pathname + (search ? '?' + search : ''));",
    "    }",
    "    async function copyValue(button, value) {",
    "      try {",
    "        if (navigator.clipboard && navigator.clipboard.writeText) {",
    "          await navigator.clipboard.writeText(value);",
    "        } else {",
    "          const el = document.createElement('textarea');",
    "          el.value = value;",
    "          document.body.appendChild(el);",
    "          el.select();",
    "          document.execCommand('copy');",
    "          el.remove();",
    "        }",
    "        const oldText = button.textContent;",
    "        button.textContent = 'Copied';",
    "        setTimeout(() => { button.textContent = oldText; }, 1800);",
    "      } catch {",
    "        const oldText = button.textContent;",
    "        button.textContent = 'Copy failed';",
    "        setTimeout(() => { button.textContent = oldText; }, 1800);",
    "      }",
    "    }",
    "    const codeFromLocation = readCodeFromLocation();",
    "    if (codeFromLocation) {",
    "      const codeInput = document.getElementById('bootstrapCode');",
    "      const status = document.getElementById('passwordStatus');",
    "      if (codeInput && typeof codeInput.value === 'string') {",
    "        codeInput.value = codeFromLocation;",
    "      }",
    "      clearCodeFromLocation();",
    "      if (status) {",
    "        status.textContent = 'Code prefilled from the link. Tap Unlock Password to redeem it once.';",
    "      }",
    "    }",
    "    window.addEventListener('pagehide', () => {",
    "      revealedUsername = '';",
    "      revealedPassword = '';",
    "    });",
    "  </script>",
    "</body>",
    "</html>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

export const buildOnboardingPageUrl = (publicBaseUrl: string): string =>
  buildMatrixOnboardingUrl(publicBaseUrl);

const buildElementWebLoginLink = (publicBaseUrl: string, username?: string): string =>
  `https://app.element.io/#/login?hs_url=${encodeURIComponent(publicBaseUrl)}${
    username === undefined ? "" : `&login_hint=${encodeURIComponent(username)}`
  }`;

const buildElementAndroidDeepLink = (publicBaseUrl: string, username?: string): string =>
  `https://mobile.element.io/?hs_url=${encodeURIComponent(publicBaseUrl)}${
    username === undefined ? "" : `&login_hint=${encodeURIComponent(username)}`
  }`;

const buildElementAndroidIntentLink = (publicBaseUrl: string, username?: string): string => {
  const fallbackUrl = buildElementAndroidDeepLink(publicBaseUrl, username);
  return (
    "intent://mobile.element.io/" +
    `?hs_url=${encodeURIComponent(publicBaseUrl)}` +
    (username === undefined ? "" : `&login_hint=${encodeURIComponent(username)}`) +
    "#Intent;scheme=https;package=im.vector.app" +
    `;S.browser_fallback_url=${encodeURIComponent(fallbackUrl)}` +
    ";end"
  );
};

const buildElementWebRoomLink = (roomId: string): string =>
  `https://app.element.io/#/room/${encodeURIComponent(roomId)}`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const normalizeEmbeddedSvg = (value: string): string =>
  value
    .replace(/<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>\s*/i, "")
    .trim();

export const renderFallbackQrSvg = (value: string): string => {
  const safeValue = escapeHtml(value);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" role="img" aria-label="Open this setup page on another device">',
    '  <rect width="320" height="320" rx="24" fill="#ffffff" />',
    '  <rect x="24" y="24" width="272" height="272" rx="16" fill="#0f172a" opacity="0.08" />',
    '  <rect x="42" y="42" width="72" height="72" rx="10" fill="#0f172a" />',
    '  <rect x="206" y="42" width="72" height="72" rx="10" fill="#0f172a" />',
    '  <rect x="42" y="206" width="72" height="72" rx="10" fill="#0f172a" />',
    '  <rect x="144" y="144" width="32" height="32" rx="6" fill="#0f172a" />',
    '  <rect x="190" y="144" width="20" height="20" rx="4" fill="#0f172a" />',
    '  <rect x="220" y="184" width="26" height="26" rx="5" fill="#0f172a" />',
    '  <text x="160" y="250" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" fill="#0f172a">Open setup page</text>',
    `  <text x="160" y="273" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#334155">${safeValue}</text>`,
    "</svg>",
  ].join("\n");
};
