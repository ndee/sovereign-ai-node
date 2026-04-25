# shellcheck shell=bash
# lib-matrix-urls: matrix domain/URL/QR helpers and onboarding-guidance printer.
#
# Depends on lib-log and (for the guidance printer) the sovereign-node CLI
# being installed. Reads and mutates RECOMMENDED_MATRIX_DOMAIN,
# RECOMMENDED_MATRIX_PUBLIC_BASE_URL, REQUEST_FILE.

refresh_recommended_matrix_defaults() {
  local detected_ip
  detected_ip="$(detect_primary_ipv4 || true)"

  if [[ -n "$detected_ip" ]]; then
    RECOMMENDED_MATRIX_DOMAIN="$detected_ip"
    RECOMMENDED_MATRIX_PUBLIC_BASE_URL="https://${detected_ip}:8448"
  else
    RECOMMENDED_MATRIX_DOMAIN="$LEGACY_MATRIX_DOMAIN"
    RECOMMENDED_MATRIX_PUBLIC_BASE_URL="$LEGACY_MATRIX_PUBLIC_BASE_URL"
  fi
}

slugify_matrix_project_name() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

build_internal_matrix_ca_path() {
  local homeserver_domain slug
  homeserver_domain="$1"
  slug="$(slugify_matrix_project_name "$homeserver_domain")"
  printf '/var/lib/sovereign-node/bundled-matrix/%s/reverse-proxy-data/caddy/pki/authorities/local/root.crt' "$slug"
}

build_matrix_onboarding_url() {
  local base_url
  base_url="${1%/}"
  printf '%s/onboard' "$base_url"
}

build_matrix_ca_download_url() {
  local base_url
  base_url="${1%/}"
  printf '%s/downloads/caddy-root-ca.crt' "$base_url"
}

build_element_web_link() {
  local base_url username matrix_domain encoded_base encoded_username
  base_url="$1"
  username="$2"
  matrix_domain="$3"

  encoded_base="$(node -p "encodeURIComponent(process.argv[1])" "$base_url")"
  if [[ -n "$username" ]] && [[ -n "$matrix_domain" ]]; then
    encoded_username="$(node -p "encodeURIComponent('@' + process.argv[1] + ':' + process.argv[2])" "$username" "$matrix_domain")"
    printf 'https://app.element.io/#/login?hs_url=%s&login_hint=%s' "$encoded_base" "$encoded_username"
    return 0
  fi

  printf 'https://app.element.io/#/login?hs_url=%s' "$encoded_base"
}

print_onboarding_qr() {
  local url
  url="$1"

  if [[ -z "$url" ]] || [[ "$NON_INTERACTIVE" == "1" ]] || ! has_tty; then
    return 0
  fi

  if ! command -v qrencode >/dev/null 2>&1; then
    return 0
  fi

  printf '\nScan on your phone:\n'
  qrencode -t ANSIUTF8 "$url" || true
  printf '\n'
}

infer_matrix_tls_mode_from_url() {
  node - "$1" <<'NODE'
const raw = process.argv[2] || "";

const isLoopback = (value) =>
  value === "localhost"
  || value === "127.0.0.1"
  || value === "::1"
  || value === "[::1]";

const isIpLiteral = (value) =>
  /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(value) || value.includes(":");

const isLikelyLanOnly = (value) =>
  isLoopback(value)
  || isIpLiteral(value)
  || !value.includes(".")
  || value.endsWith(".local")
  || value.endsWith(".localhost")
  || value.endsWith(".home.arpa")
  || value.endsWith(".internal")
  || value.endsWith(".lan");

let mode = "local-dev";
try {
  const parsed = new URL(raw);
  if (parsed.protocol === "https:") {
    const host = parsed.hostname.trim().toLowerCase();
    mode = isLikelyLanOnly(host) ? "internal" : "auto";
  }
} catch {
  mode = raw.startsWith("https://") ? "auto" : "local-dev";
}

process.stdout.write(mode);
NODE
}

print_matrix_client_onboarding_guidance() {
  local guidance guidance_payload onboarding_json onboarding_url
  [[ -r "$REQUEST_FILE" ]] || return 0

  onboarding_json="$(sovereign-node onboarding issue --json 2>/dev/null || true)"
  guidance_payload="$(
    node - "$REQUEST_FILE" "$onboarding_json" <<'NODE'
const fs = require("node:fs");
const requestPath = process.argv[2];
const onboardingRaw = process.argv[3] ?? "";
let req = {};
try {
  req = JSON.parse(fs.readFileSync(requestPath, "utf8"));
} catch {
  req = {};
}
let onboarding = {};
try {
  const parsed = JSON.parse(onboardingRaw);
  onboarding = parsed?.result ?? {};
} catch {
  onboarding = {};
}
const matrix = req?.matrix ?? {};
const issuedOnboardingUrl =
  typeof onboarding.onboardingUrl === "string" ? onboarding.onboardingUrl.replace(/\/+$/, "") : "";
const issuedUsername = typeof onboarding.username === "string" ? onboarding.username : "";
const publicBaseUrl = issuedOnboardingUrl
  ? issuedOnboardingUrl.replace(/\/onboard$/, "")
  : (typeof matrix.publicBaseUrl === "string" ? matrix.publicBaseUrl : "");
const tlsMode =
  typeof matrix.tlsMode === "string" && matrix.tlsMode.length > 0
    ? matrix.tlsMode
    : publicBaseUrl.startsWith("https://")
      ? "auto"
      : "local-dev";
if (tlsMode === "local-dev" || !publicBaseUrl) {
  process.exit(0);
}
const homeserverDomain =
  issuedUsername.includes(":")
    ? issuedUsername.slice(issuedUsername.indexOf(":") + 1)
    : (typeof matrix.homeserverDomain === "string" && matrix.homeserverDomain.length > 0
        ? matrix.homeserverDomain
        : "matrix.local.test");
const slug = homeserverDomain
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+/, "")
  .replace(/-+$/, "");
const caPath = `/var/lib/sovereign-node/bundled-matrix/${slug}/reverse-proxy-data/caddy/pki/authorities/local/root.crt`;
const normalizedBaseUrl = publicBaseUrl.replace(/\/+$/, "");
const onboardingUrl = issuedOnboardingUrl || `${normalizedBaseUrl}/onboard`;
const caDownloadUrl = `${normalizedBaseUrl}/downloads/caddy-root-ca.crt`;
const operatorUserId =
  issuedUsername.length > 0
    ? issuedUsername
    : (typeof req?.operator?.username === "string" && req.operator.username.length > 0
        ? `@${req.operator.username}:${homeserverDomain}`
        : `@operator:${homeserverDomain}`);
const elementLink =
  `https://app.element.io/#/login?hs_url=${encodeURIComponent(publicBaseUrl)}`
  + `&login_hint=${encodeURIComponent(operatorUserId)}`;
const lines = [
  "Phone onboarding:",
  `- Onboarding page: ${onboardingUrl}`,
  `- Element Web login: ${elementLink}`,
  "- Use a one-time onboarding code to unlock the password on the onboarding page.",
];
if (typeof onboarding.code === "string" && onboarding.code.length > 0) {
  lines.push(`- One-time onboarding code: ${onboarding.code}`);
}
if (typeof onboarding.expiresAt === "string" && onboarding.expiresAt.length > 0) {
  lines.push(`- Code expires at: ${onboarding.expiresAt}`);
}
if (issuedUsername.length > 0) {
  lines.push(`- Username: ${issuedUsername}`);
  lines.push("- Regenerate later: sudo sovereign-node onboarding issue");
}
if (tlsMode === "internal") {
  lines.push(`- CA download URL: ${caDownloadUrl}`);
  lines.push(`- Client CA certificate: ${caPath}`);
  lines.push("- Install this CA on every client device before using Element Web.");
}
process.stdout.write(`${onboardingUrl}\n${lines.join("\n")}`);
NODE
  )" || return 0

  if [[ -n "$guidance_payload" ]]; then
    onboarding_url="${guidance_payload%%$'\n'*}"
    guidance="${guidance_payload#*$'\n'}"
    printf '\n%s\n' "$guidance"
    print_onboarding_qr "$onboarding_url"
  fi
}
