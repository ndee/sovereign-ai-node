/**
 * Real-spawn conformance tier for the gateway manager's privilege-drop retry.
 *
 * # Why this file exists separately from gateway-service.test.ts
 *
 * Every other test of the gateway manager supplies a fake `ExecRunner`. Those
 * tests assert which command the manager *composes*, which is necessary but
 * circular as a safety net: the fake accepts whatever we hand it and returns
 * whatever we say. A composed command that the operating system would refuse
 * outright still "passes" against a fake, because nothing ever asks the OS.
 *
 * That is exactly how the defect this file guards reached a release. The
 * manager's fallback re-runs a failed gateway command as the invoking user via
 * `sudo -u`, and it decided to do so purely from `SUDO_USER`/`SUDO_UID`. Those
 * variables describe who invoked an ANCESTOR `sudo`, not who this process is,
 * and they survive a later privilege drop — `runuser -u <service-user>`
 * without `--login` sets only HOME/SHELL/USER/LOGNAME and leaves `SUDO_*`
 * untouched. An unprivileged process therefore inherited them, read them as an
 * invitation to `sudo -u`, and built a command only root may run. Every mocked
 * test stayed green because the fake runner never consulted sudo.
 *
 * So this tier spawns the real thing: a real `sudo -u` from this real non-root
 * test process, through the real exec runner, and asserts the real refusal.
 * It is the check that fails if someone drops the root guard again, regardless
 * of what the mocks say.
 *
 * # Over-correction guard
 *
 * Suppressing the retry is only correct if the retry still happens when it CAN
 * work. A "fix" that disabled the fallback unconditionally would equally
 * satisfy a test that only asserted "no sudo command was emitted", while
 * silently removing the recovery path issue #177 added. The final case below
 * pins that boundary by driving the same code with a stubbed root uid and
 * asserting the sudo retry IS still composed.
 *
 * # Portability
 *
 * Requires only `sudo` being present and this test process NOT being root —
 * both true on every supported developer machine and on CI. The one case that
 * genuinely needs sudo to be installed skips itself if it is not, and the
 * skip is narrow: the guard assertions that matter do not depend on it.
 */

import { describe, expect, it } from "vitest";

import { createLogger } from "../logging/logger.js";
import { ExecaExecRunner, type ExecInput, type ExecResult } from "../system/exec.js";
import { ShellOpenClawGatewayServiceManager } from "./gateway-service.js";

/**
 * The systemd/D-Bus stderr that makes the manager consider the sudo retry at
 * all. Taken from the real message shape `isSystemdBusUnavailableMessage`
 * recognises; if that recogniser stops matching this, the retry never triggers
 * and these tests would go vacuous — so the first test below asserts the
 * trigger actually fires rather than assuming it.
 */
const SYSTEMD_BUS_STDERR =
  "Gateway service check failed: Error: systemctl --user unavailable: " +
  "Failed to connect to bus: No medium found";

const isRoot = process.getuid?.() === 0;

/** Run `fn` with SUDO_USER/SUDO_UID set, restoring the prior values after. */
const withSudoEnv = async (user: string, uid: string, fn: () => Promise<void>): Promise<void> => {
  const priorUser = process.env.SUDO_USER;
  const priorUid = process.env.SUDO_UID;
  process.env.SUDO_USER = user;
  process.env.SUDO_UID = uid;
  try {
    await fn();
  } finally {
    if (priorUser === undefined) {
      delete process.env.SUDO_USER;
    } else {
      process.env.SUDO_USER = priorUser;
    }
    if (priorUid === undefined) {
      delete process.env.SUDO_UID;
    } else {
      process.env.SUDO_UID = priorUid;
    }
  }
};

describe("gateway privilege-drop retry against a real sudo", () => {
  /**
   * The premise, established against the real OS rather than assumed.
   *
   * Without this, a green suite could mean "the guard works" OR "sudo would
   * have succeeded anyway and the guard is pointless". Only root may switch to
   * another user unchallenged; from a non-root process sudo demands a
   * password, and with no tty it cannot even ask. This is the precise failure
   * an unprivileged install hit in the field.
   */
  it.skipIf(isRoot)(
    "real sudo -u refuses a non-root caller that has no tty",
    async () => {
      const runner = new ExecaExecRunner();
      const result = await runner.run({
        command: "sudo",
        // `-n` is NOT passed here on purpose: the product code does not pass
        // it either, and the point is to observe what the product's own
        // command shape does on a real host.
        args: ["-u", "nobody", "--", "/bin/true"],
        options: { timeout: 30_000 },
      });

      if (result.errorCode === "ENOENT") {
        // sudo is not installed on this host; the guard assertions below do
        // not need it, so do not fail the suite over a missing tool.
        return;
      }

      expect(result.exitCode).not.toBe(0);
      // Locale-independent: assert the machine-observable outcome (non-zero
      // exit, nothing produced on stdout) rather than sudo's translated prose,
      // which is German on the host that surfaced this defect.
      expect(result.stdout.trim()).toBe("");
    },
    60_000,
  );

  /**
   * The regression itself.
   *
   * With SUDO_USER/SUDO_UID inherited from an ancestor sudo — exactly what a
   * `runuser`-dropped child sees — an unprivileged manager must NOT compose a
   * `sudo -u` retry. Before the root guard it did, and the spawn died on
   * sudo's password demand, replacing the real systemd/D-Bus diagnosis with an
   * authentication error and hard-failing the install.
   *
   * Asserted through the real exec runner so the command, if one were emitted,
   * would really be spawned and really be refused.
   */
  it.skipIf(isRoot)(
    "does not attempt a sudo -u retry when the process is not root",
    async () => {
      await withSudoEnv("someinvoker", "1000", async () => {
        const spawned: ExecInput[] = [];
        const realRunner = new ExecaExecRunner();
        // Records every spawn, and really executes anything that is not the
        // primary `openclaw` call — so a sudo retry would genuinely run and
        // genuinely be refused, not merely be observed.
        const recordingRunner = {
          run: async (input: ExecInput): Promise<ExecResult> => {
            spawned.push(input);
            if (input.command === "openclaw") {
              return {
                command: "openclaw gateway install",
                exitCode: 1,
                stdout: "",
                stderr: SYSTEMD_BUS_STDERR,
              };
            }
            return await realRunner.run(input);
          },
        };

        const manager = new ShellOpenClawGatewayServiceManager(recordingRunner, createLogger());

        // The primary attempt failed, so install() must still reject — the
        // guard suppresses a bogus RETRY, it does not invent a success.
        await expect(manager.install()).rejects.toMatchObject({
          code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
        });

        // The actual regression assertion: no privilege-drop was attempted.
        expect(spawned.map((input) => input.command)).toEqual(["openclaw"]);
        expect(spawned.some((input) => input.command === "sudo")).toBe(false);
      });
    },
    60_000,
  );

  /**
   * The failure the caller reports must remain the one worth acting on.
   *
   * Before the guard, the refused sudo retry REPLACED the primary result, so
   * the install surfaced sudo's "a password is required" instead of the
   * systemd/D-Bus condition that actually explains it. Losing that diagnosis
   * is a distinct harm from the failed spawn, and it needs its own assertion:
   * a guard that skipped the retry but still discarded the primary stderr
   * would pass the test above and still cost a release cycle to diagnose.
   */
  it.skipIf(isRoot)(
    "preserves the systemd/D-Bus diagnosis instead of a sudo authentication error",
    async () => {
      await withSudoEnv("someinvoker", "1000", async () => {
        const runner = {
          run: async (input: ExecInput): Promise<ExecResult> => {
            if (input.command === "openclaw") {
              return {
                command: "openclaw gateway install",
                exitCode: 1,
                stdout: "",
                stderr: SYSTEMD_BUS_STDERR,
              };
            }
            throw new Error(`unexpected spawn: ${input.command}`);
          },
        };

        const manager = new ShellOpenClawGatewayServiceManager(runner, createLogger());
        await expect(manager.install()).rejects.toMatchObject({
          code: "OPENCLAW_GATEWAY_INSTALL_FAILED",
          details: { stderr: SYSTEMD_BUS_STDERR },
        });
      });
    },
    60_000,
  );

  /**
   * Over-correction guard: the retry must survive where it is legitimate.
   *
   * Root CAN switch users unchallenged, and issue #177's recovery path depends
   * on it. `process.getuid` is stubbed to 0 so this runs as an ordinary
   * unprivileged test while exercising the root branch; the exec runner is a
   * fake here deliberately, because actually spawning `sudo -u` as fake-root
   * would be refused for the very reason under test and would prove nothing.
   */
  it("still composes the sudo retry when the process really is root", async () => {
    await withSudoEnv("someinvoker", "1000", async () => {
      const priorGetuid = process.getuid;
      // Stubbing getuid is the only way to drive the root branch without
      // actually being root; defineProperty matches how the managed-agent
      // tests do it, so there is one pattern rather than two.
      Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
      try {
        const spawned: ExecInput[] = [];
        const runner = {
          run: async (input: ExecInput): Promise<ExecResult> => {
            spawned.push(input);
            if (input.command === "openclaw") {
              return {
                command: "openclaw gateway install",
                exitCode: 1,
                stdout: "",
                stderr: SYSTEMD_BUS_STDERR,
              };
            }
            return {
              command: [input.command, ...(input.args ?? [])].join(" "),
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          },
        };

        const manager = new ShellOpenClawGatewayServiceManager(runner, createLogger());
        await manager.install();

        expect(spawned).toHaveLength(2);
        expect(spawned[1]?.command).toBe("sudo");
        expect(spawned[1]?.args?.slice(0, 2)).toEqual(["-u", "someinvoker"]);
      } finally {
        Object.defineProperty(process, "getuid", { configurable: true, value: priorGetuid });
      }
    });
  }, 60_000);
});
