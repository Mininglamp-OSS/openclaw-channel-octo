#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const container = process.env.OCTO_E2E_CONTAINER ?? "ocprobe";
const targetUid = process.env.OCTO_E2E_TARGET_UID?.trim() ?? "";
const stateRoot = process.env.OCTO_E2E_STATE_ROOT ?? "/root/.openclaw-dev";
const configPath = `${stateRoot}/openclaw.json`;
const extensionsRoot = `${stateRoot}/extensions`;
const octoRoot = `${extensionsRoot}/octo`;
const companionRoot = `${extensionsRoot}/octo-host-e2e`;
const requestRoot = "/tmp/octo-host-e2e";
const configStatePath = "/tmp/octo-host-e2e-config-state.json";
const gatewayLog = "/tmp/gw-openclaw-card-host-e2e.log";
const gatewayToken = process.env.OCTO_E2E_GATEWAY_TOKEN ?? "octo-card-e2e";
const sessionsDir = `${stateRoot}/agents/main/sessions`;
const sessionsStore = `${sessionsDir}/sessions.json`;

const CONFIG_HELPER = String.raw`
const fs = require("node:fs");
const mode = process.argv[1];
const configPath = process.argv[2];
const statePath = process.argv[3];
const pluginId = "octo-host-e2e";
const providerId = "octo-e2e";
const modelRef = "octo-e2e/scripted";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.plugins ??= {};
config.plugins.entries ??= {};
config.models ??= {};
config.models.providers ??= {};
config.agents ??= {};
config.agents.defaults ??= {};
config.agents.defaults.models ??= {};
if (mode === "setup") {
  const state = {
    hadEntry: Object.prototype.hasOwnProperty.call(config.plugins.entries, pluginId),
    entry: config.plugins.entries[pluginId],
    hadAllow: Object.prototype.hasOwnProperty.call(config.plugins, "allow"),
    allow: config.plugins.allow,
    hadProvider: Object.prototype.hasOwnProperty.call(config.models.providers, providerId),
    provider: config.models.providers[providerId],
    hadAgentModel: Object.prototype.hasOwnProperty.call(config.agents.defaults.models, modelRef),
    agentModel: config.agents.defaults.models[modelRef],
    hadThinkingDefault: Object.prototype.hasOwnProperty.call(config.agents.defaults, "thinkingDefault"),
    thinkingDefault: config.agents.defaults.thinkingDefault,
    hadReasoningDefault: Object.prototype.hasOwnProperty.call(config.agents.defaults, "reasoningDefault"),
    reasoningDefault: config.agents.defaults.reasoningDefault,
  };
  fs.writeFileSync(statePath, JSON.stringify(state));
  config.plugins.entries[pluginId] = {
    enabled: true,
    hooks: { allowConversationAccess: true },
  };
  const allow = Array.isArray(config.plugins.allow) ? config.plugins.allow : [];
  config.plugins.allow = [...new Set([...allow, pluginId])];
  config.models.providers[providerId] = {
    baseUrl: "http://127.0.0.1:19123/v1",
    apiKey: "octo-host-e2e",
    request: { allowPrivateNetwork: true },
    models: [{ id: "scripted", name: "Octo Host E2E Scripted", api: "openai-completions", reasoning: true }],
  };
  config.agents.defaults.models[modelRef] = {};
  config.agents.defaults.thinkingDefault = "low";
  config.agents.defaults.reasoningDefault = "stream";
} else {
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { state = {}; }
  if (state.hadEntry) config.plugins.entries[pluginId] = state.entry;
  else delete config.plugins.entries[pluginId];
  if (state.hadAllow) config.plugins.allow = state.allow;
  else delete config.plugins.allow;
  if (state.hadProvider) config.models.providers[providerId] = state.provider;
  else delete config.models.providers[providerId];
  if (state.hadAgentModel) config.agents.defaults.models[modelRef] = state.agentModel;
  else delete config.agents.defaults.models[modelRef];
  if (state.hadThinkingDefault) config.agents.defaults.thinkingDefault = state.thinkingDefault;
  else delete config.agents.defaults.thinkingDefault;
  if (state.hadReasoningDefault) config.agents.defaults.reasoningDefault = state.reasoningDefault;
  else delete config.agents.defaults.reasoningDefault;
  try { fs.unlinkSync(statePath); } catch {}
}
const tmp = configPath + ".octo-host-e2e-" + process.pid;
fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(tmp, configPath);
`;

const SESSION_CLEANUP_HELPER = String.raw`
const fs = require("node:fs");
const storePath = process.argv[1];
const sessionsDir = process.argv[2];
const prefix = "agent:main:octo-host-e2e:";
let store;
try { store = JSON.parse(fs.readFileSync(storePath, "utf8")); } catch { process.exit(0); }
const removedKeys = new Set(Object.keys(store).filter((key) => key.startsWith(prefix)));
let changed = true;
while (changed) {
  changed = false;
  for (const [key, entry] of Object.entries(store)) {
    if (removedKeys.has(key)) continue;
    const parents = [entry?.spawnedBy, entry?.spawnedByKey, entry?.requesterSessionKey,
      entry?.parentSessionKey, entry?.completionOwnerKey];
    if (parents.some((parent) => typeof parent === "string" && removedKeys.has(parent))) {
      removedKeys.add(key);
      changed = true;
    }
  }
}
const sessionIds = [];
for (const key of removedKeys) {
  const id = store[key]?.sessionId;
  if (typeof id === "string" && id) sessionIds.push(id);
  delete store[key];
}
if (removedKeys.size > 0) {
  const tmp = storePath + ".octo-host-e2e-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, storePath);
}
let names = [];
try { names = fs.readdirSync(sessionsDir); } catch {}
for (const name of names) {
  if (!name.endsWith(".trajectory.jsonl")) continue;
  try {
    const content = fs.readFileSync(sessionsDir + "/" + name, "utf8");
    if (content.includes("agent:main:subagent:") && content.includes("octo-host-e2e")) {
      sessionIds.push(name.slice(0, -".trajectory.jsonl".length));
    }
  } catch {}
}
for (const id of sessionIds) {
  for (const name of names) {
    if (name.startsWith(id + ".")) fs.rmSync(sessionsDir + "/" + name, { force: true });
  }
}
process.stdout.write(String(removedKeys.size));
`;

function info(message) {
  process.stdout.write(`[openclaw-e2e] ${message}\n`);
}

async function run(file, args, options = {}) {
  return await execFileAsync(file, args, {
    cwd: repoRoot,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: options.env ?? process.env,
  });
}

async function runStreaming(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: repoRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited with ${signal ?? code}`));
    });
  });
}

async function docker(args, options) {
  return await run("docker", args, options);
}

async function mutateConfig(mode) {
  await docker([
    "exec", container, "node", "-e", CONFIG_HELPER,
    mode, configPath, configStatePath,
  ]);
}

async function removeContainerPaths(paths) {
  const script = "const fs=require('node:fs');for(const p of process.argv.slice(1))fs.rmSync(p,{recursive:true,force:true})";
  await docker(["exec", container, "node", "-e", script, ...paths]);
}

async function cleanupE2ESessions() {
  const { stdout } = await docker([
    "exec", container, "node", "-e", SESSION_CLEANUP_HELPER,
    sessionsStore, sessionsDir,
  ]);
  info(`removed ${stdout.trim() || "0"} prior E2E session(s)`);
}

async function stopGateway() {
  await docker([
    "exec", container, "sh", "-lc",
    "pkill -TERM -x openclaw 2>/dev/null || true",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function startGateway(debug) {
  await docker([
    "exec", container, "node", "-e",
    "require('node:fs').writeFileSync(process.argv[1], '')", gatewayLog,
  ]);
  const envArgs = ["-e", `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`];
  if (debug) envArgs.push("-e", "OCTO_CARD_DEBUG=1");
  await docker([
    "exec", "-d", ...envArgs, container,
    "sh", "-lc",
    `openclaw --dev gateway run --allow-unconfigured >> ${gatewayLog} 2>&1`,
  ]);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await docker([
        "exec", container, "node", "-e",
        "const fs=require('node:fs');const p=process.argv[1];if(!fs.existsSync(p)||!fs.readFileSync(p,'utf8').includes('[gateway] ready'))process.exit(2)",
        gatewayLog,
      ], { timeout: 5_000 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const { stdout = "" } = await docker([
    "exec", container, "node", "-e",
    "const fs=require('node:fs');const p=process.argv[1];if(fs.existsSync(p))process.stdout.write(fs.readFileSync(p,'utf8').slice(-8000))",
    gatewayLog,
  ]).catch(() => ({ stdout: "" }));
  throw new Error(`gateway did not become ready within 30s\n${stdout}`);
}

async function installCurrentBuildAndCompanion() {
  await removeContainerPaths([`${octoRoot}/dist`, companionRoot, requestRoot]);
  await docker(["exec", container, "mkdir", "-p", `${octoRoot}/dist`, companionRoot, requestRoot]);
  await docker(["cp", `${repoRoot}/dist/.`, `${container}:${octoRoot}/dist/`]);
  await docker(["cp", `${repoRoot}/e2e/openclaw-host-plugin/.`, `${container}:${companionRoot}/`]);
  await docker(["exec", container, "chown", "-R", "root:root", `${octoRoot}/dist`, companionRoot, requestRoot]);
}

async function cleanup(configured) {
  info("cleaning companion plugin and restoring config");
  await stopGateway();
  await cleanupE2ESessions();
  if (configured) await mutateConfig("cleanup");
  await removeContainerPaths([companionRoot, requestRoot]);
  await startGateway(false);
}

async function main() {
  if (!targetUid) {
    throw new Error("OCTO_E2E_TARGET_UID is required (the Octo DM user that receives test cards)");
  }

  info(`checking container ${container}`);
  await docker(["inspect", container], { timeout: 10_000 });
  info("building current checkout");
  await runStreaming("npm", ["run", "build"]);

  let configured = false;
  let preparationStarted = false;
  let failure;
  try {
    preparationStarted = true;
    await stopGateway();
    await cleanupE2ESessions();
    await mutateConfig("setup");
    configured = true;
    await installCurrentBuildAndCompanion();
    info("restarting real OpenClaw gateway with card lifecycle diagnostics");
    await startGateway(true);
    info("running Octo inbound -> spawn -> yield -> follow-up -> completion E2E");
    const testArgs = [
      "vitest", "run", "src/card-openclaw-e2e.test.ts", "--reporter=verbose",
    ];
    const testName = process.env.OCTO_E2E_TEST_NAME?.trim();
    if (testName) testArgs.push("-t", testName);
    await runStreaming("npx", testArgs, {
      env: {
        ...process.env,
        OCTO_OPENCLAW_E2E: "1",
        OCTO_E2E_CONTAINER: container,
        OCTO_E2E_TARGET_UID: targetUid,
      },
    });
  } catch (error) {
    failure = error;
  }

  if (preparationStarted) {
    try {
      await cleanup(configured);
    } catch (cleanupError) {
      if (!failure) throw cleanupError;
      process.stderr.write(`[openclaw-e2e] cleanup failed: ${cleanupError}\n`);
    }
  }
  if (failure) throw failure;
  info("GREEN; companion removed and gateway restarted cleanly");
}

main().catch((error) => {
  process.stderr.write(`[openclaw-e2e] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
