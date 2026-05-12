import { useCallback, useEffect, useState } from "../../vendor/preact-hooks.module.js";

const STORAGE_KEY = "sov:setup-ui:wizard:v1";

const DEFAULT_STATE = {
  v: 1,
  matrix: {
    deployMode: "public",
    tlsMode: "auto",
    homeserverDomain: "",
    publicBaseUrl: "",
    federationEnabled: false,
    alertRoomName: "Sovereign Alerts",
  },
  operator: {
    username: "operator",
  },
  imap: {
    host: "",
    port: 993,
    tls: true,
    username: "",
    mailbox: "INBOX",
  },
  openrouter: {
    model: "qwen/qwen3.5-9b",
  },
  bots: {
    selected: ["mail-sentinel", "node-operator"],
  },
  preflight: null,
  jobId: null,
};

const merge = (base, persisted) => {
  if (persisted === null || typeof persisted !== "object") return base;
  return {
    ...base,
    ...persisted,
    matrix: { ...base.matrix, ...(persisted.matrix ?? {}) },
    operator: { ...base.operator, ...(persisted.operator ?? {}) },
    imap: { ...base.imap, ...(persisted.imap ?? {}) },
    openrouter: { ...base.openrouter, ...(persisted.openrouter ?? {}) },
    bots: { ...base.bots, ...(persisted.bots ?? {}) },
  };
};

export const readPersistedWizardState = (storage = window.localStorage) => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1) return DEFAULT_STATE;
    return merge(DEFAULT_STATE, parsed);
  } catch {
    return DEFAULT_STATE;
  }
};

export const writePersistedWizardState = (state, storage = window.localStorage) => {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable; the wizard still works in-memory.
  }
};

export const clearPersistedWizardState = (storage = window.localStorage) => {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — we'll fall through with in-memory state
  }
};

export const useWizardState = () => {
  const [state, setState] = useState(() => readPersistedWizardState());

  useEffect(() => {
    writePersistedWizardState(state);
  }, [state]);

  const update = useCallback((patch) => {
    setState((prev) => {
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      return next;
    });
  }, []);

  const updateSection = useCallback((section, patch) => {
    setState((prev) => ({
      ...prev,
      [section]: {
        ...prev[section],
        ...(typeof patch === "function" ? patch(prev[section]) : patch),
      },
    }));
  }, []);

  const reset = useCallback(() => {
    clearPersistedWizardState();
    setState(DEFAULT_STATE);
  }, []);

  return { state, update, updateSection, reset };
};

export const buildInstallRequest = (state, secrets) => {
  const matrix = {
    homeserverDomain: state.matrix.homeserverDomain.trim(),
    publicBaseUrl: state.matrix.publicBaseUrl.trim(),
    federationEnabled: state.matrix.federationEnabled === true,
  };
  if (state.matrix.tlsMode && state.matrix.tlsMode !== "auto") {
    matrix.tlsMode = state.matrix.tlsMode;
  } else if (state.matrix.tlsMode === "auto") {
    matrix.tlsMode = "auto";
  }
  const alertRoomName = state.matrix.alertRoomName?.trim();
  if (alertRoomName) matrix.alertRoomName = alertRoomName;

  const operator = {
    username: state.operator.username.trim(),
  };
  if (secrets.operatorPassword && secrets.operatorPassword.length > 0) {
    operator.password = secrets.operatorPassword;
  }

  const openrouter = {};
  const trimmedModel = state.openrouter.model?.trim();
  if (trimmedModel) openrouter.model = trimmedModel;
  if (secrets.openrouterApiKey && secrets.openrouterApiKey.length > 0) {
    openrouter.apiKey = secrets.openrouterApiKey;
  }

  const imap = {
    host: state.imap.host.trim(),
    port: state.imap.port,
    tls: state.imap.tls === true,
    username: state.imap.username.trim(),
  };
  if (state.imap.mailbox && state.imap.mailbox.trim().length > 0) {
    imap.mailbox = state.imap.mailbox.trim();
  }
  if (secrets.imapPassword && secrets.imapPassword.length > 0) {
    imap.password = secrets.imapPassword;
  }

  const bots =
    state.bots.selected && state.bots.selected.length > 0
      ? { selected: state.bots.selected }
      : undefined;

  const request = {
    mode: "bundled_matrix",
    matrix,
    operator,
    openrouter,
    imap,
  };
  if (bots !== undefined) request.bots = bots;
  return request;
};

const DEPLOY_MODE_LABEL = {
  public: "Public site (TLS via bundled reverse proxy)",
  lan: "Local LAN (HTTPS via local CA)",
  dev: "Local dev (no TLS, this machine only)",
};

// Build the Review step summary, grouped into sections so the operator can
// scan one area at a time. Secrets stay out of this list — they're handled
// separately by the Review step's secrets-ok banner.
export const summarizeRequest = (state) => [
  {
    title: "Matrix",
    rows: [
      {
        label: "Deployment mode",
        value: DEPLOY_MODE_LABEL[state.matrix.deployMode ?? "public"] ?? "Public site",
      },
      { label: "Matrix URL", value: state.matrix.publicBaseUrl || "—" },
      { label: "Homeserver domain", value: state.matrix.homeserverDomain || "—" },
      {
        label: "Federation",
        value: state.matrix.federationEnabled ? "enabled" : "disabled (recommended)",
      },
      { label: "Alert room", value: state.matrix.alertRoomName || "Sovereign Alerts" },
      { label: "Operator", value: state.operator.username || "—" },
    ],
  },
  {
    title: "Mailbox",
    rows: [
      { label: "Host", value: state.imap.host || "—" },
      { label: "Port", value: String(state.imap.port ?? 993) },
      { label: "TLS", value: state.imap.tls ? "on" : "off" },
      { label: "Username", value: state.imap.username || "—" },
      { label: "Folder", value: state.imap.mailbox || "INBOX" },
    ],
  },
  {
    title: "Provider",
    rows: [{ label: "Initial default model", value: state.openrouter.model || "(default)" }],
  },
  {
    title: "Components",
    rows: [
      {
        label: "Included",
        value: (state.bots.selected ?? []).join(", ") || "—",
      },
    ],
  },
];
