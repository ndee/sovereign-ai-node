import { h } from "../vendor/preact.module.js";
import htm from "../vendor/htm.module.js";

const html = htm.bind(h);

export const Stepper = ({ steps, currentIndex }) => html`
  <ol class="stepper">
    ${steps.map((label, index) => {
      const state =
        index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
      return html`
        <li class=${`stepper__item stepper__item--${state}`}>
          <span class="stepper__dot" aria-hidden="true"></span>
          <span class="stepper__label">${label}</span>
        </li>
      `;
    })}
  </ol>
`;
