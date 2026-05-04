import { h } from "./vendor/preact.module.js";
import htm from "./vendor/htm.module.js";
import { useState } from "./vendor/preact-hooks.module.js";

const html = htm.bind(h);

// Copy `value` to the clipboard. Tries the modern Clipboard API first;
// falls back to a hidden textarea + document.execCommand("copy"), which
// is the only path that works on insecure HTTP origins (the wizard runs
// over plain HTTP on LAN IPs, where navigator.clipboard is undefined).
// Returns true on success, false on failure.
export const copyToClipboard = async (value) => {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
};

export const CopyButton = ({ value, label, kind = "secondary" }) => {
  const [state, setState] = useState("idle");
  const onClick = async () => {
    const ok = await copyToClipboard(value);
    setState(ok ? "ok" : "fail");
    window.setTimeout(() => setState("idle"), 2500);
  };
  const klass = kind === "primary" ? "btn" : `btn btn--${kind}`;
  return html`
    <button class=${klass} type="button" onClick=${onClick}>
      ${state === "ok"
        ? "Copied"
        : state === "fail"
          ? "Copy failed — select manually"
          : (label ?? "Copy")}
    </button>
  `;
};

export const Field = ({ label, hint, children }) => html`
  <label class="field">
    <span class="field__label">${label}</span>
    ${children}
    ${hint ? html`<span class="field__hint">${hint}</span>` : null}
  </label>
`;

export const TextInput = ({ value, onInput, placeholder, type = "text", disabled = false, autocomplete }) => html`
  <input
    class="input"
    type=${type}
    value=${value ?? ""}
    placeholder=${placeholder ?? ""}
    autocomplete=${autocomplete ?? "off"}
    disabled=${disabled}
    onInput=${(event) => onInput(event.currentTarget.value)}
  />
`;

export const NumberInput = ({
  value,
  onInput,
  placeholder,
  disabled = false,
  min,
  max,
  step,
}) => html`
  <input
    class="input"
    type="number"
    value=${value ?? ""}
    placeholder=${placeholder ?? ""}
    disabled=${disabled}
    min=${min ?? undefined}
    max=${max ?? undefined}
    step=${step ?? undefined}
    onInput=${(event) => {
      const raw = event.currentTarget.value;
      onInput(raw === "" ? undefined : Number(raw));
    }}
  />
`;

export const Checkbox = ({ checked, onInput, label, disabled = false }) => html`
  <label class="row">
    <input
      class="checkbox"
      type="checkbox"
      checked=${checked}
      disabled=${disabled}
      onInput=${(event) => onInput(event.currentTarget.checked)}
    />
    <span>${label}</span>
  </label>
`;

export const SubmitButton = ({ children, disabled, busy, kind = "primary" }) => html`
  <button
    class=${kind === "primary" ? "btn" : `btn btn--${kind}`}
    type="submit"
    disabled=${disabled || busy}
  >
    ${busy ? "Working…" : children}
  </button>
`;

export const ErrorBanner = ({ error }) => {
  if (!error) return null;
  const message = error.detail?.message ?? error.message ?? String(error);
  const code = error.detail?.code;
  return html`
    <div class="alert alert--error">
      <strong>${code ?? "Error"}:</strong> ${message}
    </div>
  `;
};

export const SuccessBanner = ({ message }) => {
  if (!message) return null;
  return html`<div class="alert alert--success">${message}</div>`;
};
