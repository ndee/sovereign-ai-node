import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const APPLY_TASKS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "deploy",
  "ansible",
  "roles",
  "sovereign_host_resources_apply",
  "tasks",
  "main.yml",
);

type Task = {
  name: string;
  when?: string;
  "ansible.builtin.command"?: { argv: string | string[]; chdir?: string };
  "ansible.builtin.set_fact"?: Record<string, string>;
  "ansible.builtin.assert"?: { that: string[] };
};

const readTasks = async (): Promise<Task[]> => parse(await readFile(APPLY_TASKS, "utf8")) as Task[];

const argvText = (task: Task): string => {
  const argv = task["ansible.builtin.command"]?.argv;
  return Array.isArray(argv) ? argv.join(" ") : (argv ?? "");
};

describe("the post-install host reconciliation", () => {
  it("runs every OpenClaw CLI call as the service user, from its home", async () => {
    const tasks = await readTasks();
    const openclawTasks = tasks.filter((task) => /'cron'|\bopenclaw\b(?!_)/.test(argvText(task)));

    expect(openclawTasks.map((task) => task.name)).toEqual([
      "List OpenClaw cron jobs",
      "Remove superseded or absent OpenClaw cron jobs",
      "Ensure declared OpenClaw cron jobs exist",
    ]);
    for (const task of openclawTasks) {
      const argv = argvText(task);
      expect(argv, task.name).toMatch(/^\{\{\s*sovereign_host_resources_openclaw_argv\b/);
      expect(argv, task.name).not.toMatch(/['"]openclaw['"]/);
      expect(task["ansible.builtin.command"]?.chdir, task.name).toBe(
        "{{ sovereign_host_resources_openclaw_cwd }}",
      );
    }
  });

  it("drops to the plan's service user with the gateway's OpenClaw environment", async () => {
    const tasks = await readTasks();
    const resolve = tasks.find((task) => task.name === "Resolve how OpenClaw CLI calls run");
    const facts = resolve?.["ansible.builtin.set_fact"];

    const argv = facts?.sovereign_host_resources_openclaw_argv ?? "";
    expect(argv).toMatch(
      /\['runuser', '-u', sovereign_host_resources_plan\.openclawCli\.user, '--', 'env',/,
    );
    for (const key of ["HOME", "OPENCLAW_HOME"]) {
      expect(argv).toContain(`'${key}=' ~ sovereign_host_resources_plan.openclawCli.home`);
    }
    for (const key of ["OPENCLAW_CONFIG", "OPENCLAW_CONFIG_PATH"]) {
      expect(argv).toContain(`'${key}=' ~ sovereign_host_resources_plan.openclawCli.configPath`);
    }
    expect(argv).toContain("+ sovereign_host_resources_plan.openclawCli.command");
    expect(facts?.sovereign_host_resources_openclaw_cwd).toBe(
      "{{ sovereign_host_resources_plan.openclawCli.home }}",
    );
  });

  it("only calls OpenClaw for a plan with OpenClaw cron jobs, and then requires the identity", async () => {
    const tasks = await readTasks();
    const byName = (name: string) => tasks.find((task) => task.name === name);

    for (const name of [
      "Require the OpenClaw CLI identity for OpenClaw cron jobs",
      "Resolve how OpenClaw CLI calls run",
      "List OpenClaw cron jobs",
    ]) {
      expect(byName(name)?.when, name).toBe("sovereign_host_resource_crons | length > 0");
    }
    expect(
      byName("Require the OpenClaw CLI identity for OpenClaw cron jobs")?.["ansible.builtin.assert"]
        ?.that,
    ).toEqual(["sovereign_host_resources_plan.openclawCli is defined"]);
  });
});
