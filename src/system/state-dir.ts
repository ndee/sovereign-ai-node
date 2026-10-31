import { userInfo } from "node:os";
import { resolve } from "node:path";

/**
 * Where a developer checkout keeps state it cannot write to the real
 * `/etc/sovereign-node` and `/var/lib/sovereign-node` locations.
 */
export const SOVEREIGN_DEV_STATE_DIR_NAME = ".sovereign-node-dev";

/**
 * Explicit opt-in for relocating unwritable state dirs under
 * `<cwd>/.sovereign-node-dev`. Only the `dev:*` package scripts set it.
 *
 * It has to be explicit: at runtime there is no reliable way to tell "a
 * checkout that cannot write /var/lib" from "a real node whose state dir has
 * the wrong owner". Guessing turned the second case into a silent relocation
 * that left Synapse with an empty data dir and surfaced much later as an
 * unrelated Matrix login failure.
 */
export const DEV_STATE_FALLBACK_ENV = "SOVEREIGN_NODE_DEV_STATE_FALLBACK";

export const devStateFallbackDir = (
  segment: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null => {
  if (env[DEV_STATE_FALLBACK_ENV] !== "1") {
    return null;
  }
  return resolve(cwd, SOVEREIGN_DEV_STATE_DIR_NAME, segment);
};

// `userInfo()` throws when the uid has no passwd entry (some containers).
export const runningUserName = (
  info: () => { username: string } = () => userInfo(),
): string | null => {
  try {
    return info().username;
  } catch {
    return null;
  }
};

export type StateDirUnwritableError = Error & {
  code: string;
  retryable: false;
  details: {
    dir: string;
    requiredOwner: string;
    requiredMode: string;
    suggestedFix: string;
    cause: string;
    causeCode?: string;
  };
};

export const stateDirUnwritableError = (input: {
  code: string;
  label: string;
  dir: string;
  mode: number;
  cause: unknown;
  owner?: string | null;
}): StateDirUnwritableError => {
  const owner = input.owner === undefined ? runningUserName() : input.owner;
  const requiredOwner = owner ?? "<service-user>";
  const requiredMode = input.mode.toString(8).padStart(4, "0");
  const suggestedFix = [
    `sudo mkdir -p ${input.dir}`,
    `sudo chown ${requiredOwner}: ${input.dir}`,
    `sudo chmod ${requiredMode} ${input.dir}`,
  ].join(" && ");
  const cause = input.cause instanceof Error ? input.cause.message : String(input.cause);
  const causeCode = (input.cause as NodeJS.ErrnoException | undefined)?.code;
  const runningAs = owner === null ? "the user this service runs as" : `"${owner}"`;
  const error = new Error(
    `${input.label} ${input.dir} is not writable by ${runningAs}. ` +
      `It must exist, be owned by ${requiredOwner}, and have mode ${requiredMode}. ` +
      `Fix: ${suggestedFix}, then retry. Underlying error: ${cause}`,
  );
  return Object.assign(error, {
    code: input.code,
    retryable: false as const,
    details: {
      dir: input.dir,
      requiredOwner,
      requiredMode,
      suggestedFix,
      cause,
      ...(typeof causeCode === "string" ? { causeCode } : {}),
    },
  });
};
