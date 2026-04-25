import { h } from "./vendor/preact.module.js";
import htm from "./vendor/htm.module.js";
import { useState } from "./vendor/preact-hooks.module.js";

import { apiPost } from "./api.js";
import { CheckList } from "./components/CheckList.js";
import {
  Checkbox,
  ErrorBanner,
  Field,
  NumberInput,
  TextInput,
} from "./forms.js";

const html = htm.bind(h);

const SERVICE_LABELS = {
  "openclaw-gateway": "OpenClaw gateway",
  "sovereign-node": "Sovereign Node API",
  synapse: "Matrix homeserver",
  postgres: "Postgres",
  "reverse-proxy": "Reverse proxy",
  "relay-tunnel": "Relay tunnel",
};

const restartLine = (services) => {
  if (!services || services.length === 0) return null;
  const friendly = services.map((s) => SERVICE_LABELS[s] ?? s);
  if (friendly.length === 1) {
    return `${friendly[0]} will restart to pick up the change. This usually takes a few seconds.`;
  }
  const last = friendly.pop();
  return `${friendly.join(", ")} and ${last} will restart to pick up the change. This usually takes a few seconds.`;
};

const ApplyResult = ({ result }) => {
  if (!result) return null;
  return html`
    <div class="alert alert--success">
      Applied. ${restartLine(result.restartRequiredServices) ?? "No service restart needed."}
    </div>
    ${result.changed && result.changed.length > 0
      ? html`
          <p class="muted">
            Updated:
            ${result.changed.map(
              (field, idx) => html`${idx === 0 ? "" : ", "}<code>${field}</code>`,
            )}
          </p>
        `
      : null}
    ${result.validation && result.validation.length > 0
      ? html`<${CheckList} checks=${result.validation} />`
      : null}
  `;
};

const useApplyForm = ({ buildPayload, testEndpoint, applyEndpoint, hasTest }) => {
  const [phase, setPhase] = useState(hasTest ? "editing" : "tested-ok");
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [applyResult, setApplyResult] = useState(null);

  const markDirty = () => {
    if (hasTest && phase !== "editing") setPhase("editing");
    setApplyResult(null);
  };

  const test = async () => {
    setPhase("testing");
    setError(null);
    setTestResult(null);
    try {
      const payload = buildPayload();
      const result = await apiPost(testEndpoint, payload.test);
      setTestResult(result);
      setPhase(result.ok ? "tested-ok" : "tested-fail");
    } catch (err) {
      setError(err);
      setPhase("tested-fail");
    }
  };

  const apply = async () => {
    setPhase("applying");
    setError(null);
    setApplyResult(null);
    try {
      const payload = buildPayload();
      const result = await apiPost(applyEndpoint, payload.apply);
      setApplyResult(result);
      setPhase("applied-ok");
    } catch (err) {
      setError(err);
      setPhase("applied-fail");
    }
  };

  return { phase, error, testResult, applyResult, markDirty, test, apply };
};

const ImapForm = () => {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(993);
  const [tls, setTls] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState("");

  const buildPayload = () => {
    const imap = {
      host: host.trim(),
      port,
      tls,
      username: username.trim(),
      password,
      ...(mailbox.trim().length > 0 ? { mailbox: mailbox.trim() } : {}),
    };
    return { test: { imap }, apply: { imap } };
  };

  const form = useApplyForm({
    buildPayload,
    testEndpoint: "/api/install/test-imap",
    applyEndpoint: "/api/reconfigure/imap",
    hasTest: true,
  });

  const wrap = (setter) => (value) => {
    setter(value);
    form.markDirty();
  };

  const formValid =
    host.trim().length > 0 &&
    username.trim().length > 0 &&
    password.length > 0 &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535;

  const testing = form.phase === "testing";
  const applying = form.phase === "applying";
  const canApply = form.phase === "tested-ok" && formValid && !applying;

  return html`
    <form
      onSubmit=${(event) => {
        event.preventDefault();
        if (canApply) form.apply();
      }}
    >
      <${ErrorBanner} error=${form.error} />
      <${Field} label="Host">
        <${TextInput} value=${host} onInput=${wrap(setHost)} placeholder="imap.example.com" />
      <//>
      <div class="row">
        <${Field} label="Port">
          <${NumberInput} value=${port} onInput=${(value) => wrap(setPort)(value ?? 993)} />
        <//>
        <${Field} label="TLS">
          <${Checkbox} checked=${tls} onInput=${wrap(setTls)} label="Use TLS (IMAPS)" />
        <//>
      </div>
      <${Field} label="Username">
        <${TextInput} value=${username} onInput=${wrap(setUsername)} />
      <//>
      <${Field}
        label="Password"
        hint="Re-enter the mailbox password to test and apply. We never echo persisted secrets to the browser."
      >
        <${TextInput} value=${password} onInput=${wrap(setPassword)} type="password" />
      <//>
      <${Field} label="Folder (optional)">
        <${TextInput} value=${mailbox} onInput=${wrap(setMailbox)} placeholder="INBOX" />
      <//>
      <div class="btn-row">
        <button
          class="btn btn--secondary"
          type="button"
          onClick=${form.test}
          disabled=${!formValid || testing || applying}
        >
          ${testing ? "Testing…" : "Test connection"}
        </button>
        <button class="btn" type="submit" disabled=${!canApply}>
          ${applying ? "Applying…" : "Apply"}
        </button>
      </div>
      ${form.testResult
        ? html`
            <div class="alert alert--${form.testResult.ok ? "success" : "error"}">
              ${form.testResult.ok
                ? `Connection ok on ${form.testResult.host}:${form.testResult.port}.`
                : "Connection failed. Apply is disabled until a passing test."}
            </div>
            ${!form.testResult.ok && form.testResult.error
              ? html`<p class="muted">${form.testResult.error.message}</p>`
              : null}
          `
        : null}
      <${ApplyResult} result=${form.applyResult} />
    </form>
  `;
};

const MatrixForm = () => {
  const [homeserverDomain, setHomeserverDomain] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [federationEnabled, setFederationEnabled] = useState(false);
  const [operatorUsername, setOperatorUsername] = useState("");

  const buildPayload = () => {
    const matrix = {
      ...(homeserverDomain.trim().length > 0 ? { homeserverDomain: homeserverDomain.trim() } : {}),
      ...(publicBaseUrl.trim().length > 0 ? { publicBaseUrl: publicBaseUrl.trim() } : {}),
      federationEnabled,
    };
    const operator =
      operatorUsername.trim().length > 0 ? { username: operatorUsername.trim() } : undefined;
    const apply = {
      ...(Object.keys(matrix).length > 0 ? { matrix } : {}),
      ...(operator !== undefined ? { operator } : {}),
    };
    const test = {
      publicBaseUrl: publicBaseUrl.trim(),
      federationEnabled,
    };
    return { test, apply };
  };

  const form = useApplyForm({
    buildPayload,
    testEndpoint: "/api/install/test-matrix",
    applyEndpoint: "/api/reconfigure/matrix",
    hasTest: true,
  });

  const wrap = (setter) => (value) => {
    setter(value);
    form.markDirty();
  };

  const canTest = publicBaseUrl.trim().length > 0;
  const testing = form.phase === "testing";
  const applying = form.phase === "applying";
  const hasAnything =
    homeserverDomain.trim().length > 0 ||
    publicBaseUrl.trim().length > 0 ||
    operatorUsername.trim().length > 0;
  const canApply = form.phase === "tested-ok" && hasAnything && !applying;

  return html`
    <form
      onSubmit=${(event) => {
        event.preventDefault();
        if (canApply) form.apply();
      }}
    >
      <${ErrorBanner} error=${form.error} />
      <${Field} label="Public base URL">
        <${TextInput}
          value=${publicBaseUrl}
          onInput=${wrap(setPublicBaseUrl)}
          placeholder="https://matrix.example.com"
        />
      <//>
      <${Field} label="Homeserver domain">
        <${TextInput}
          value=${homeserverDomain}
          onInput=${wrap(setHomeserverDomain)}
          placeholder="matrix.example.com"
        />
      <//>
      <${Field} label="Federation">
        <${Checkbox}
          checked=${federationEnabled}
          onInput=${wrap(setFederationEnabled)}
          label="Enable federation"
        />
      <//>
      <${Field} label="Operator username (optional)">
        <${TextInput} value=${operatorUsername} onInput=${wrap(setOperatorUsername)} />
      <//>
      <div class="btn-row">
        <button
          class="btn btn--secondary"
          type="button"
          onClick=${form.test}
          disabled=${!canTest || testing || applying}
        >
          ${testing ? "Testing…" : "Test connection"}
        </button>
        <button class="btn" type="submit" disabled=${!canApply}>
          ${applying ? "Applying…" : "Apply"}
        </button>
      </div>
      ${form.testResult
        ? html`
            <div class="alert alert--${form.testResult.ok ? "success" : "error"}">
              ${form.testResult.ok
                ? `Matrix homeserver reachable at ${form.testResult.homeserverUrl}.`
                : "Matrix homeserver could not be reached. Apply is disabled until a passing test."}
            </div>
            <${CheckList} checks=${form.testResult.checks ?? []} />
          `
        : null}
      <${ApplyResult} result=${form.applyResult} />
    </form>
  `;
};

const ProviderForm = () => {
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");

  const buildPayload = () => {
    const openrouter = {
      ...(model.trim().length > 0 ? { model: model.trim() } : {}),
      ...(apiKey.length > 0 ? { apiKey } : {}),
    };
    return { test: null, apply: { openrouter } };
  };

  const form = useApplyForm({
    buildPayload,
    testEndpoint: null,
    applyEndpoint: "/api/reconfigure/openrouter",
    hasTest: false,
  });

  const wrap = (setter) => (value) => {
    setter(value);
    form.markDirty();
  };

  const applying = form.phase === "applying";
  const canApply = (model.trim().length > 0 || apiKey.length > 0) && !applying;

  return html`
    <form
      onSubmit=${(event) => {
        event.preventDefault();
        if (canApply) form.apply();
      }}
    >
      <${ErrorBanner} error=${form.error} />
      <p class="muted">
        OpenRouter has no test endpoint, so the key is validated server-side at apply. Provide at
        least one of model or API key.
      </p>
      <${Field} label="Model (optional)">
        <${TextInput} value=${model} onInput=${wrap(setModel)} placeholder="qwen/qwen3.5-9b" />
      <//>
      <${Field} label="API key (optional)">
        <${TextInput} value=${apiKey} onInput=${wrap(setApiKey)} type="password" />
      <//>
      <div class="btn-row">
        <button class="btn" type="submit" disabled=${!canApply}>
          ${applying ? "Applying…" : "Apply"}
        </button>
      </div>
      <${ApplyResult} result=${form.applyResult} />
    </form>
  `;
};

const TARGETS = {
  imap: {
    title: "Reconfigure mailbox",
    subtitle: "Update IMAP credentials. We test the new connection before saving.",
    component: ImapForm,
  },
  matrix: {
    title: "Reconfigure Matrix",
    subtitle: "Update homeserver settings. We test reachability before saving.",
    component: MatrixForm,
  },
  openrouter: {
    title: "Reconfigure provider",
    subtitle: "Update OpenRouter model or API key.",
    component: ProviderForm,
  },
};

export const Reconfigure = ({ target }) => {
  const entry = TARGETS[target] ?? TARGETS.imap;
  const Form = entry.component;
  return html`
    <section class="hero">
      <h1>${entry.title}</h1>
      <p>${entry.subtitle}</p>
    </section>
    <section class="section">
      <div class="card">
        <${Form} />
      </div>
    </section>
  `;
};
