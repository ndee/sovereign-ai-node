import { h } from "../../vendor/preact.module.js";
import htm from "../../vendor/htm.module.js";
import { useCallback, useEffect, useState } from "../../vendor/preact-hooks.module.js";

import { apiGet } from "../../api.js";
import { navigate } from "../../router.js";

import { MailboxStep } from "./MailboxStep.js";
import { MatrixStep } from "./MatrixStep.js";
import { ModulesStep } from "./ModulesStep.js";
import { Preflight } from "./Preflight.js";
import { ProgressStep } from "./ProgressStep.js";
import { ProviderStep } from "./ProviderStep.js";
import { ReviewStep } from "./ReviewStep.js";
import { SuccessStep } from "./SuccessStep.js";
import { Welcome } from "./Welcome.js";
import { useWizardState } from "./state.js";

const html = htm.bind(h);

export const WIZARD_STEP_ORDER = [
  "welcome",
  "preflight",
  "matrix",
  "mailbox",
  "provider",
  "modules",
  "review",
  "progress",
  "done",
];

const stepFromRoute = (route) => {
  const m = route.match(/^\/setup\/([a-z]+)$/);
  if (m && WIZARD_STEP_ORDER.includes(m[1])) return m[1];
  return null;
};

const goto = (step) => navigate(`/setup/${step}`);

export const Wizard = ({ route, onModeChange }) => {
  const { state, update, updateSection, reset } = useWizardState();
  const [secrets, setSecrets] = useState({
    operatorPassword: "",
    imapPassword: "",
    openrouterApiKey: "",
  });
  const [installResult, setInstallResult] = useState(null);

  const updateSecret = useCallback((key, value) => {
    setSecrets((prev) => ({ ...prev, [key]: value }));
  }, []);

  const stepFromUrl = stepFromRoute(route);
  const currentStep = stepFromUrl ?? "welcome";

  useEffect(() => {
    if (route === "/setup" || route === "/setup/" || stepFromUrl === null) {
      goto("welcome");
    }
  }, [route, stepFromUrl]);

  // Resume mid-install if a job is recorded
  useEffect(() => {
    if (state.jobId === null || installResult !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiGet(
          `/api/install/jobs/${encodeURIComponent(state.jobId)}`,
        );
        if (cancelled) return;
        if (response.job.state === "succeeded" && response.result) {
          setInstallResult(response.result);
          goto("done");
        } else if (response.job.state === "failed" || response.job.state === "canceled") {
          // Reset jobId so the operator can retry
          update({ jobId: null });
          goto("review");
        } else {
          goto("progress");
        }
      } catch {
        // ignore — operator can retry from the wizard
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = (target) => () => goto(target);

  const onSucceeded = useCallback(
    (jobResponse) => {
      setInstallResult(jobResponse.result ?? null);
      goto("done");
      // After success, refresh mode so admin nav becomes available
      if (typeof onModeChange === "function") onModeChange();
    },
    [onModeChange],
  );

  const onFailed = useCallback(
    () => {
      update({ jobId: null });
      goto("review");
    },
    [update],
  );

  const onManageNode = useCallback(() => {
    reset();
    setSecrets({ operatorPassword: "", imapPassword: "", openrouterApiKey: "" });
    if (typeof onModeChange === "function") onModeChange();
  }, [reset, onModeChange]);

  switch (currentStep) {
    case "welcome":
      return html`<${Welcome} onNext=${next("preflight")} />`;
    case "preflight":
      return html`<${Preflight}
        wizardState=${state}
        onUpdateWizard=${update}
        onBack=${next("welcome")}
        onNext=${next("matrix")}
      />`;
    case "matrix":
      return html`<${MatrixStep}
        wizardState=${state}
        onUpdateSection=${updateSection}
        secrets=${secrets}
        onUpdateSecret=${updateSecret}
        onBack=${next("preflight")}
        onNext=${next("mailbox")}
      />`;
    case "mailbox":
      return html`<${MailboxStep}
        wizardState=${state}
        onUpdateSection=${updateSection}
        secrets=${secrets}
        onUpdateSecret=${updateSecret}
        onBack=${next("matrix")}
        onNext=${next("provider")}
      />`;
    case "provider":
      return html`<${ProviderStep}
        wizardState=${state}
        onUpdateSection=${updateSection}
        secrets=${secrets}
        onUpdateSecret=${updateSecret}
        onBack=${next("mailbox")}
        onNext=${next("modules")}
      />`;
    case "modules":
      return html`<${ModulesStep} onBack=${next("provider")} onNext=${next("review")} />`;
    case "review":
      return html`<${ReviewStep}
        wizardState=${state}
        secrets=${secrets}
        onBack=${next("modules")}
        onNext=${next("progress")}
      />`;
    case "progress":
      return html`<${ProgressStep}
        wizardState=${state}
        secrets=${secrets}
        onUpdateWizard=${update}
        onBack=${next("review")}
        onSucceeded=${onSucceeded}
        onFailed=${onFailed}
      />`;
    case "done":
      return html`<${SuccessStep} result=${installResult} onManageNode=${onManageNode} />`;
    default:
      return null;
  }
};
