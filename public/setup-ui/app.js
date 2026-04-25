import { h, render } from "./vendor/preact.module.js";
import htm from "./vendor/htm.module.js";

import { useHashRoute } from "./router.js";
import { Install } from "./screens/install.js";
import { Status } from "./screens/status.js";
import { Reconfigure } from "./screens/reconfigure.js";
import { Onboarding } from "./screens/onboarding.js";

const html = htm.bind(h);

const NAV = [
  { label: "Install", path: "/install", group: "Setup" },
  { label: "Status", path: "/status", group: "Operate" },
  { label: "IMAP", path: "/reconfigure/imap", group: "Reconfigure" },
  { label: "Matrix", path: "/reconfigure/matrix", group: "Reconfigure" },
  { label: "OpenRouter", path: "/reconfigure/openrouter", group: "Reconfigure" },
  { label: "Onboarding code", path: "/onboarding", group: "Operate" },
];

const matchRoute = (route) => {
  if (route === "/" || route === "/install") return { name: "install" };
  if (route === "/status") return { name: "status" };
  if (route === "/reconfigure/imap") return { name: "reconfigure", target: "imap" };
  if (route === "/reconfigure/matrix") return { name: "reconfigure", target: "matrix" };
  if (route === "/reconfigure/openrouter") return { name: "reconfigure", target: "openrouter" };
  if (route === "/onboarding") return { name: "onboarding" };
  return { name: "install" };
};

const Nav = ({ active }) => {
  const groups = ["Setup", "Operate", "Reconfigure"];
  return html`
    <nav class="nav">
      <div class="nav__brand">
        Sovereign AI Node
        <small>Setup &amp; admin</small>
      </div>
      ${groups.map(
        (group) => html`
          <div class="nav__group">${group}</div>
          ${NAV.filter((entry) => entry.group === group).map(
            (entry) => html`
              <a
                class=${`nav__link ${active === entry.path ? "nav__link--active" : ""}`}
                href=${`#${entry.path}`}
              >
                ${entry.label}
              </a>
            `,
          )}
        `,
      )}
    </nav>
  `;
};

const Screen = ({ route }) => {
  const matched = matchRoute(route);
  if (matched.name === "install") return html`<${Install} />`;
  if (matched.name === "status") return html`<${Status} />`;
  if (matched.name === "reconfigure") return html`<${Reconfigure} target=${matched.target} />`;
  if (matched.name === "onboarding") return html`<${Onboarding} />`;
  return null;
};

const App = () => {
  const route = useHashRoute();
  const activePath = route === "/" ? "/install" : route;
  return html`
    <div class="app-shell">
      <${Nav} active=${activePath} />
      <main class="main">
        <${Screen} route=${route} />
      </main>
    </div>
  `;
};

const root = document.getElementById("root");
if (root !== null) {
  render(html`<${App} />`, root);
}
