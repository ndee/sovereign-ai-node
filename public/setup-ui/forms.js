import { h } from "./vendor/preact.module.js";
import htm from "./vendor/htm.module.js";

const html = htm.bind(h);

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

export const NumberInput = ({ value, onInput, placeholder, disabled = false }) => html`
  <input
    class="input"
    type="number"
    value=${value ?? ""}
    placeholder=${placeholder ?? ""}
    disabled=${disabled}
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
