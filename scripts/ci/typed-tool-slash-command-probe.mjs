// Calls the installed typed-tool plugin's slash command handler the way the
// gateway does, with no model anywhere in the path. Arguments: the plugin's
// extension dir, the rendered openclaw.json5 and a writable scratch dir.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [extensionDir, openclawConfigPath, scratchDir] = process.argv.slice(2);
const copyDir = await mkdtemp(join(scratchDir, "typed-tool-slash-"));
try {
  for (const name of ["index.js", "runtime.js", "plugin-config.json"]) {
    await copyFile(join(extensionDir, name), join(copyDir, name));
  }
  await writeFile(join(copyDir, "package.json"), '{"type":"module"}\n');
  const configPath = join(copyDir, "plugin-config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const tool = config.tools.find((candidate) => candidate.name === "mail_sentinel");
  assert.ok(tool, "the plugin has no mail_sentinel tool");
  // A bots release that predates the declaration still exercises the handler.
  if (tool.slashCommands?.version === undefined) {
    console.log("::notice::the installed Mail Sentinel does not declare /version; checking the handler with it declared");
    tool.slashCommands = { ...tool.slashCommands, version: "version" };
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }
  const binding = tool.bindings.find((candidate) => typeof candidate.accountId === "string");
  assert.ok(binding, "no mail_sentinel binding carries a Matrix account");
  const accounts = Object.keys(
    JSON.parse(await readFile(openclawConfigPath, "utf8")).channels?.matrix?.accounts ?? {},
  );
  assert.ok(
    accounts.includes(binding.accountId),
    `binding account ${binding.accountId} is not a Matrix account (${accounts.join(", ")})`,
  );

  const commands = new Map();
  const hooks = [];
  const plugin = await import(pathToFileURL(join(copyDir, "index.js")).href);
  plugin.default({
    registerTool: () => undefined,
    registerCommand: (command) => commands.set(command.name, command),
    on: (name, handler) => hooks.push({ name, handler }),
  });
  const version = commands.get("version");
  assert.ok(version, "the plugin registered no /version command");
  assert.equal(version.acceptsArgs, false);
  assert.equal(version.requireAuth, true);

  const reply = await version.handler({ channel: "matrix", accountId: binding.accountId });
  assert.equal(typeof reply.text, "string");
  assert.match(reply.text, /Mail Sentinel|"version"/);
  assert.doesNotMatch(reply.text, /exited with code|Unknown operation/);
  assert.deepEqual(await version.handler({ channel: "matrix", accountId: `not-${binding.accountId}` }), {});

  const rewrites = Array.isArray(config.replyPayloadRewrites) ? config.replyPayloadRewrites : [];
  if (rewrites.length > 0) {
    assert.deepEqual(hooks.map((hook) => hook.name), ["reply_payload_sending"]);
    const rewritten = hooks[0].handler(
      { payload: { text: `404 ${rewrites[0].contains}.` } },
      { channelId: "matrix" },
    );
    assert.equal(rewritten?.payload?.text, rewrites[0].text);
  } else {
    assert.deepEqual(hooks, []);
  }
  console.log(
    JSON.stringify({ accountId: binding.accountId, reply: reply.text, replyRewrites: rewrites.length }),
  );
} finally {
  await rm(copyDir, { recursive: true, force: true });
}
