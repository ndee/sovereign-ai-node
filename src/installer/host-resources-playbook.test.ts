import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const roleTasks = (role: string) =>
  join(REPO_ROOT, "deploy", "ansible", "roles", role, "tasks", "main.yml");
const APPLY_TASKS = roleTasks("sovereign_host_resources_apply");
const VERIFY_TASKS = roleTasks("sovereign_host_resources_verify");
const CI_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

type Task = {
  name: string;
  when?: string;
  "ansible.builtin.command"?: { argv: string | string[]; chdir?: string; stdin?: string };
  "ansible.builtin.copy"?: { content?: string };
  "ansible.builtin.set_fact"?: Record<string, string>;
  "ansible.builtin.assert"?: { that: string[] };
};

const readTasks = async (path = APPLY_TASKS): Promise<Task[]> =>
  parse(await readFile(path, "utf8")) as Task[];

type WorkflowJob = {
  container?: string;
  needs?: string[];
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps?: Array<{ name?: string; run?: string }>;
};

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

  // ansible-core up to 2.18 literal-evals a templated value that looks like
  // JSON, and a string module parameter then receives the Python repr.
  it("never hands a templated value to a process's stdin", async () => {
    for (const path of [APPLY_TASKS, VERIFY_TASKS]) {
      for (const task of await readTasks(path)) {
        expect(task["ansible.builtin.command"]?.stdin, task.name).toBeUndefined();
      }
    }
  });

  it("parses the OpenClaw cron list where it is cached", async () => {
    const tasks = await readTasks();
    const cache = tasks.find((task) => task.name === "Cache OpenClaw cron jobs");
    const jobs = cache?.["ansible.builtin.set_fact"]?.sovereign_host_resources_openclaw_jobs ?? "";

    expect(jobs).toContain("set listed = sovereign_host_resources_openclaw_cron_list");
    expect(jobs).toContain("listed.stdout | from_json");
    expect(jobs).toContain("raw.get('jobs') or raw.get('crons')");
    expect(tasks.filter((task) => /\bpython3?\b/.test(argvText(task)))).toEqual([]);
  });

  it("writes file and unit content as the plan's string", async () => {
    const copies = (await readTasks()).filter((task) => task["ansible.builtin.copy"]?.content);

    expect(copies.map((task) => task.name)).toEqual([
      "Write managed files and state files",
      "Write managed systemd units",
    ]);
    for (const task of copies) {
      expect(task["ansible.builtin.copy"]?.content, task.name).toBe("{{ item.content | string }}");
    }
  });

  it("runs in CI on the ansible-core each supported distro packages", async () => {
    const jobs = (
      parse(await readFile(CI_WORKFLOW, "utf8")) as { jobs: Record<string, WorkflowJob> }
    ).jobs;
    const compat = jobs.host_resources_ansible;
    const variants = compat?.strategy?.matrix?.include ?? [];

    expect(compat?.container).toMatch(/^\$\{\{ matrix\.image \}\}$/);
    expect(variants.map(({ image, expect: version }) => [image, version])).toEqual(
      expect.arrayContaining([
        ["debian:12", "2.14."],
        ["ubuntu:24.04", "2.16."],
      ]),
    );
    expect(compat?.steps?.map((step) => step.run)).toContain(
      "bash scripts/ci/test-host-resources-ansible.sh",
    );
    expect(jobs.release_gate?.needs).toContain("host_resources_ansible");

    const installSteps = (jobs.e2e_noninteractive?.steps ?? []).map((step) => step.name);
    expect(installSteps.indexOf("Remove the runner's preinstalled Ansible")).toBeGreaterThan(-1);
    expect(installSteps.indexOf("Remove the runner's preinstalled Ansible")).toBeLessThan(
      installSteps.indexOf("Run full installer (install.sh, non-interactive)"),
    );
  });
});
