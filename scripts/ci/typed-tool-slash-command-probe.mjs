// Calls the installed typed-tool plugin's slash command handler the way the
// gateway does, with no model anywhere in the path. Arguments: the plugin's
// extension dir, the rendered openclaw.json5, a writable scratch dir and the
// gateway's openclaw executable.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [extensionDir, openclawConfigPath, scratchDir, openclawExecutable] = process.argv.slice(2);

// OpenRouter's body for a model no allowed provider serves, as captured from a
// provider.only pin that cannot serve the chat model.
const OPENROUTER_UNSERVABLE_MODEL_ERROR =
  "No allowed providers are available for the selected model. Providers serving qwen/qwen3.5-27b-20260224: alibaba, chutes, siliconflow, deepinfra, atlas-cloud, novita, but your request's provider.only preference permits only: groq.";

const findOpenClawPackageRoot = async (executable) => {
  let current = dirname(await realpath(executable));
  while (current !== dirname(current)) {
    const manifest = await readFile(join(current, "package.json"), "utf8").catch(() => null);
    if (manifest !== null && JSON.parse(manifest).name === "openclaw") {
      return current;
    }
    current = dirname(current);
  }
  throw new Error(`${executable} is not inside an openclaw package`);
};

// The dist chunks carry content hashes and one-letter export aliases, but each
// export list keeps the source name, so the function is found by that name.
const importOpenClawExport = async (packageRoot, name) => {
  const dist = join(packageRoot, "dist");
  const pattern = new RegExp(`\\b${name} as ([\\w$]+)`);
  const found = [];
  for (const file of (await readdir(dist)).filter((entry) => entry.endsWith(".js"))) {
    const source = await readFile(join(dist, file), "utf8");
    for (const exportList of source.matchAll(/^export \{([^}]*)\};$/gm)) {
      const alias = exportList[1].match(pattern)?.[1];
      if (alias !== undefined) {
        found.push({ file, alias });
      }
    }
  }
  assert.equal(found.length, 1, `expected one openclaw dist chunk to export ${name}: ${JSON.stringify(found)}`);
  const module = await import(pathToFileURL(join(dist, found[0].file)).href);
  assert.equal(typeof module[found[0].alias], "function", `${name} in ${found[0].file} is not a function`);
  return module[found[0].alias];
};
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
  let openclawFailureReply;
  if (rewrites.length > 0) {
    assert.deepEqual(hooks.map((hook) => hook.name), ["reply_payload_sending"]);
    const calmLines = new Set(rewrites.map((rewrite) => rewrite.text));
    assert.equal(calmLines.size, 1, "the reply rewrites disagree on the replacement line");
    const [calmLine] = calmLines;
    const rewrite = (text) =>
      hooks[0].handler({ payload: { text, isError: true } }, { channelId: "matrix" })?.payload?.text;

    assert.equal(rewrite(`404 ${OPENROUTER_UNSERVABLE_MODEL_ERROR}`), calmLine);

    // The text the hook really receives is whatever the installed OpenClaw's
    // reply builder makes of the provider failure, so take it from there: when
    // a release rewords it, no rewrite matches any more and this check fails.
    // HOME points at the scratch copy so the import cannot reach a real state.
    process.env.HOME = copyDir;
    const buildExternalRunFailureReply = await importOpenClawExport(
      await findOpenClawPackageRoot(openclawExecutable),
      "buildExternalRunFailureReply",
    );
    openclawFailureReply = buildExternalRunFailureReply(`404 ${OPENROUTER_UNSERVABLE_MODEL_ERROR}`);
    assert.equal(
      openclawFailureReply.isGenericRunnerFailure,
      false,
      `OpenClaw no longer classifies the provider 404: ${openclawFailureReply.text}`,
    );
    assert.equal(
      rewrite(openclawFailureReply.text),
      calmLine,
      `no reply rewrite matches OpenClaw's reply for the provider 404: ${openclawFailureReply.text}`,
    );
  } else {
    assert.deepEqual(hooks, []);
  }
  console.log(
    JSON.stringify({
      accountId: binding.accountId,
      reply: reply.text,
      replyRewrites: rewrites.length,
      openclawFailureReply: openclawFailureReply?.text,
    }),
  );
} finally {
  await rm(copyDir, { recursive: true, force: true });
}
