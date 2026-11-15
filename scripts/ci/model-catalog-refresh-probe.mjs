// Runs the installed OpenClaw gateway on a copy of the rendered config and
// checks the hosted model catalog switch:
//   rendered  the config as node renders it (catalogRefresh.enabled false):
//             no catalog request at startup or on any scheduled refresh, and
//             a chat turn and an llm-task call still get their model reply;
//   control   the same config with catalogRefresh.enabled true: the catalog
//             is requested, so the counter would have seen it.
// The copy has no Matrix channel and points the OpenRouter provider at a local
// stub, so every model reply comes from the stub and no real key is needed.
//
// Usage: node model-catalog-refresh-probe.mjs <openclaw.mjs> <openclaw.json5> <scratch dir>
// Prints one JSON summary line; exits 1 when a check fails.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [openclawEntry, renderedConfigPath, scratchDir] = process.argv.slice(2);
if (!openclawEntry || !renderedConfigPath || !scratchDir) {
  console.error("usage: model-catalog-refresh-probe.mjs <openclaw.mjs> <openclaw.json5> <scratch dir>");
  process.exit(64);
}
const preload = join(dirname(fileURLToPath(import.meta.url)), "model-catalog-probe-preload.mjs");
// The default catalog host of OpenClaw 2026.8 (models.catalogRefresh.url unset).
const CATALOG_HOST = "catalog.openclaw.ai";
const PROBE_REPLY = "catalog-probe-ok";
const TICKS_WANTED = 2;
const EXTERNAL_PLUGINS = ["matrix", "lobster"];
const failures = [];
const check = (ok, message) => {
  console.error(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rendered = JSON.parse(await readFile(renderedConfigPath, "utf8"));
check(
  rendered.models?.catalogRefresh?.enabled === false,
  `the rendered config sets models.catalogRefresh.enabled false (${JSON.stringify(rendered.models)})`,
);
const entries = rendered.agents?.entries ?? {};
const chatAgent = rendered.agents?.defaults?.systemAgent?.agentId ?? Object.keys(entries)[0];
// Node gives scan agents no skills; the chat agent may hold llm-task as well.
const allowsLlmTask = (id) => (entries[id].tools?.allow ?? []).includes("llm-task");
const scanAgent =
  Object.keys(entries).find((id) => allowsLlmTask(id) && entries[id].skills?.length === 0) ??
  Object.keys(entries).find(allowsLlmTask);
const llmTask = rendered.plugins?.entries?.["llm-task"]?.config;
const stripProvider = (model) => model?.replace(/^openrouter\//, "");
const expectedChatModel = stripProvider(entries[chatAgent]?.model ?? rendered.agents?.defaults?.model);
const expectedTaskModel = llmTask?.defaultModel;

const stubRequests = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    stubRequests.push({ method: req.method, path: req.url, model: parsed.model });
    if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
      const message = { role: "assistant", content: JSON.stringify({ probe: PROBE_REPLY }) };
      if (parsed.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk = (choice) =>
          res.write(
            `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: parsed.model, choices: [choice] })}\n\n`,
          );
        chunk({ index: 0, delta: message, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "probe",
          object: "chat.completion",
          created: 0,
          model: parsed.model,
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    if (req.method === "GET" && /\/models(\?|$)/.test(req.url)) {
      const ids = [expectedChatModel, expectedTaskModel].filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: ids.map((id) => ({
            id,
            name: id,
            context_length: 32768,
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            pricing: { prompt: "0", completion: "0" },
            supported_parameters: ["tools", "response_format"],
            top_provider: { max_completion_tokens: 4096 },
          })),
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubBase = `http://127.0.0.1:${stub.address().port}/api/v1`;

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const readEvents = async (path) =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const runCase = async (name, catalogRefresh) => {
  const dir = await mkdtemp(join(scratchDir, `catalog-probe-${name}-`));
  const home = join(dir, "home");
  const configPath = join(home, ".openclaw", "openclaw.json5");
  const eventsPath = join(dir, "events.jsonl");
  await mkdir(join(home, ".openclaw"), { recursive: true });
  await mkdir(join(dir, "tmp"), { recursive: true });
  const port = await freePort();
  const config = structuredClone(rendered);
  config.gateway = { ...config.gateway, port };
  // Matrix and lobster are plugins node installs into the gateway's own state
  // dir; the probe calls llm-task the way lobster does, over /tools/invoke.
  const { matrix: _matrix, ...channels } = config.channels ?? {};
  config.channels = channels;
  config.bindings = (config.bindings ?? []).filter((binding) => binding.match?.channel !== "matrix");
  if (config.bindings.length === 0) delete config.bindings;
  for (const plugin of EXTERNAL_PLUGINS) delete config.plugins?.entries?.[plugin];
  if (Array.isArray(config.plugins?.allow)) {
    config.plugins.allow = config.plugins.allow.filter((plugin) => !EXTERNAL_PLUGINS.includes(plugin));
  }
  config.models = {
    ...config.models,
    catalogRefresh,
    providers: { ...config.models?.providers, openrouter: { baseUrl: stubBase } },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_CONFIG: configPath,
    OPENCLAW_CONFIG_PATH: configPath,
    TMPDIR: join(dir, "tmp"),
    OPENROUTER_API_KEY: "catalog-probe-key",
    CI: "1",
  };
  const gatewayLog = createWriteStream(join(dir, "gateway.log"));
  const gateway = spawn(
    process.execPath,
    [openclawEntry, "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--port", String(port)],
    {
      env: {
        ...env,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        SOVEREIGN_CI_PROBE_LOG: eventsPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  gateway.stdout.pipe(gatewayLog);
  gateway.stderr.pipe(gatewayLog);
  let exited = null;
  gateway.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const result = { case: name, catalogRefresh, dir };
  try {
    let listening = false;
    for (let i = 0; i < 90 && exited === null; i += 1) {
      listening = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
        .then(() => true)
        .catch(() => false);
      if (listening) break;
      await sleep(2000);
    }
    result.listening = listening;
    if (!listening) {
      result.exited = exited;
      return result;
    }

    // The first refresh runs right after startup; each later one is a timer tick.
    for (let i = 0; i < 60; i += 1) {
      const ticks = (await readEvents(eventsPath)).filter((event) => event.kind === "catalog-tick");
      if (ticks.length >= TICKS_WANTED) break;
      await sleep(1000);
    }

    const agent = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [openclawEntry, "agent", "--agent", chatAgent, "--message", "Reply with the probe word.", "--json", "--timeout", "120"],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    result.chat = { exitCode: agent.code, repliedWithStub: agent.stdout.includes(PROBE_REPLY) };
    if (!result.chat.repliedWithStub) {
      result.chat.output = `${agent.stdout}\n${agent.stderr}`.slice(-2000);
    }

    if (scanAgent !== undefined) {
      const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.gateway?.auth?.token}`,
        },
        body: JSON.stringify({
          tool: "llm-task",
          action: "json",
          args: {
            prompt: "Classify the message. Answer with JSON only.",
            timeoutMs: 60000,
            input: { from: "probe@example.org", subject: "probe", body: "probe" },
          },
          sessionKey: `agent:${scanAgent}:main`,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const text = await response.text();
      result.llmTask = { status: response.status, repliedWithStub: text.includes(PROBE_REPLY) };
      if (!result.llmTask.repliedWithStub) result.llmTask.output = text.slice(0, 2000);
    }
  } finally {
    if (exited === null) {
      gateway.kill("SIGTERM");
      for (let i = 0; i < 20 && exited === null; i += 1) await sleep(500);
      if (exited === null) gateway.kill("SIGKILL");
    }
    gatewayLog.end();
  }

  const events = await readEvents(eventsPath);
  const gatewayEvents = events.filter((event) => event.pid === gateway.pid);
  result.catalogTimers = gatewayEvents.filter((event) => event.kind === "catalog-timer").length;
  result.catalogTicks = gatewayEvents.filter((event) => event.kind === "catalog-tick").length;
  result.catalogLookups = events.filter((e) => e.kind === "lookup" && e.host === CATALOG_HOST).length;
  result.catalogRequests = events.filter((e) => e.kind === "request" && e.host === CATALOG_HOST).length;
  result.outboundHosts = [...new Set(events.filter((e) => e.kind !== "catalog-timer" && e.kind !== "catalog-tick").map((e) => e.host))];
  return result;
};

const summary = { chatAgent, scanAgent, expectedChatModel, expectedTaskModel, cases: [] };
try {
  for (const [name, catalogRefresh] of [
    ["rendered", rendered.models?.catalogRefresh],
    ["control", { ...rendered.models?.catalogRefresh, enabled: true }],
  ]) {
    const before = stubRequests.length;
    const result = await runCase(name, catalogRefresh);
    result.modelRequests = stubRequests
      .slice(before)
      .filter((request) => request.path.endsWith("/chat/completions"))
      .map((request) => request.model);
    summary.cases.push(result);

    check(result.listening, `${name}: the gateway listens (${JSON.stringify(result.exited ?? null)})`);
    if (!result.listening) continue;
    check(
      result.catalogTicks >= TICKS_WANTED,
      `${name}: ${result.catalogTicks} scheduled catalog refreshes ran (want >= ${TICKS_WANTED})`,
    );
    check(result.chat?.exitCode === 0 && result.chat.repliedWithStub, `${name}: the chat agent ${chatAgent} replied through the model`);
    check(
      result.modelRequests.includes(expectedChatModel),
      `${name}: the chat turn asked for ${expectedChatModel} (${result.modelRequests.join(", ")})`,
    );
    if (scanAgent !== undefined) {
      check(
        result.llmTask?.status === 200 && result.llmTask.repliedWithStub,
        `${name}: llm-task for ${scanAgent} returned the model's JSON`,
      );
      check(
        result.modelRequests.includes(expectedTaskModel),
        `${name}: llm-task asked for ${expectedTaskModel}`,
      );
    }
    const catalogTraffic = result.catalogLookups + result.catalogRequests;
    if (name === "rendered") {
      check(catalogTraffic === 0, `${name}: no lookup of or request to ${CATALOG_HOST} (${catalogTraffic})`);
    } else {
      check(catalogTraffic > 0, `${name}: the catalog was requested from ${CATALOG_HOST} (${catalogTraffic})`);
    }
  }
} finally {
  stub.close();
}
console.log(JSON.stringify(summary));
if (failures.length === 0) {
  for (const result of summary.cases) await rm(result.dir, { recursive: true, force: true });
}
process.exit(failures.length === 0 ? 0 : 1);
