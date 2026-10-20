// Requires a full instance-aware host installation; Agent execution alone is
// stubbed. Real registration, host admission, socket codec and HTTP egress run.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createSyntheticOcto, REPLY } from "./synthetic-octo.mjs";
import { cleanupAll } from "./cleanup.mjs";
import { isolateHostProcess } from "../../scripts/openclaw-e2e-host-env.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const hostRoot = process.env.OCTO_RUNTIME_HOST_ROOT ?? path.resolve(path.dirname(require.resolve("openclaw/plugin-sdk/runtime-store")), "../..");
const { version } = JSON.parse(readFileSync(path.join(hostRoot, "package.json"), "utf8"));
isolateHostProcess("octo-production-path-");
const setupFile = readdirSync(path.join(hostRoot, "dist")).find((n) => /^plugin-setup-module-.*\.m?js$/.test(n));
assert.ok(setupFile, `SDK ${version} must provide managed PluginInstance for this integration probe`);
const host = await import(pathToFileURL(path.join(hostRoot, "dist", setupFile)).href);
const PluginInstance = Object.values(host).find((v) => typeof v === "function" && v.name === "PluginInstance");
assert.ok(PluginInstance, "must load the actual host admission/lifecycle implementation");
const fixture = mkdtempSync(path.join(repoRoot, "src/.tmp-runtime-channel-"));
let server;
let live;
let candidate;
let controller;
let running;
let deadline;
let failure;
let failed = false;
try {
  cpSync(path.join(repoRoot, "dist"), path.join(fixture, "dist"), { recursive: true });
  cpSync(path.join(repoRoot, "openclaw.plugin.json"), path.join(fixture, "openclaw.plugin.json"));
  writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}\n');
  mkdirSync(path.join(fixture, "node_modules"));
  for (const name of readdirSync(path.join(repoRoot, "node_modules"))) {
    symlinkSync(name === "openclaw" ? hostRoot : path.join(repoRoot, "node_modules", name),
      path.join(fixture, "node_modules", name), "dir");
  }
  const entry = (await import(pathToFileURL(path.join(fixture, "dist/index.js")).href)).default;
  const octoRuntime = await import(pathToFileURL(path.join(fixture, "dist/src/runtime.js")).href);
  server = await createSyntheticOcto();
  const logs = [];
  const log = { info: (s) => logs.push(s), warn: (s) => logs.push(s), error: (s) => logs.push(s), debug() {} };
  const config = { plugins: { entries: { octo: { hooks: { allowConversationAccess: true } } } },
    channels: { octo: { accounts: { scope: { enabled: true, botToken: "synthetic-token",
      apiUrl: server.baseUrl, docTasks: false, botTasks: false } } } } };
  live = new PluginInstance("octo");
  candidate = new PluginInstance("octo");
  // Use the real host's loader/admission API with the already-built test package.
  for (const owner of [live, candidate]) owner.bindModuleLoader((source) => require(source));
  let plugin;
  let dispatched = false;
  const runtime = { version, config: { current: () => config }, channel: {
    reply: { dispatchReplyWithBufferedBlockDispatcher: async (args) => {
      assert.equal(octoRuntime.getOctoRuntime(), runtime);
      assert.equal(live.hasActiveCall, true);
      dispatched = true;
      await args.dispatcherOptions.deliver({ text: REPLY }, { kind: "final" });
    }, resolveEnvelopeFormatOptions: () => ({}), formatAgentEnvelope: ({ body }) => body,
    finalizeInboundContext: (ctx) => ctx },
    routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "agent:main:octo:scope:direct:user", accountId: "scope" }) },
    session: { resolveStorePath: () => path.join(fixture, "session-store"), readSessionUpdatedAt: () => undefined,
      recordInboundSession: async () => {} },
  } };
  const api = { id: "octo", registrationMode: "full", runtime, config, logger: log,
    registerTool() {}, on() {}, registerChannel: ({ plugin: value }) => { plugin = live.wrap(value); } };
  live.run(() => entry.register(api));
  candidate.run(() => entry.register({ ...api, runtime: { ...runtime, version: "candidate" }, registerChannel() {} }));
  await candidate.dispose();
  candidate = undefined;
  controller = new AbortController();
  running = Promise.resolve(plugin.gateway.startAccount({ account: { accountId: "scope", enabled: true, configured: true,
    config: config.channels.octo.accounts.scope }, cfg: config, log, setStatus() {}, abortSignal: controller.signal }));
  await Promise.race([server.delivered, server.failed, running.then(() => { throw new Error("account stopped before delivery"); }), new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error(`delivery timeout\n${logs.join("\n")}\nrequests=${server.requests}`)), 8_000);
  })]);
  assert.equal(dispatched, true);
  assert.equal(server.acked, true);
  assert.equal(server.agentVersion, version);
  assert.deepEqual(server.unknown, []);
  console.log(`SDK ${version}: PASS real entry registration -> managed startAccount -> encrypted WS -> inbound -> HTTP final; candidate retired; Agent dispatcher stubbed`);
} catch (error) { failed = true; failure = error; }
finally {
  clearTimeout(deadline);
  await cleanupAll([
    () => controller?.abort(), () => running,
    () => server?.close(), () => candidate?.dispose(), () => live?.dispose(),
    () => rmSync(fixture, { recursive: true, force: true }),
  ], ...(failed ? [failure] : []));
}
