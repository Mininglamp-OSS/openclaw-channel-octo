// Container-local E2E resource ledger. The runner invokes every operation under
// Linux flock; the persistent lease survives runner SIGKILL/container restart.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";

export const CONTROL_ROOT = "/var/lib/octo-host-e2e";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkId(id) { if (!uuid.test(id)) throw new Error("invalid E2E run id"); }
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function paths(root, id) {
  checkId(id);
  const runDir = path.join(root, "runs", id);
  return { runDir, profile: path.join(runDir, "profile"), requests: path.join(runDir, "requests"),
    gatewayLog: path.join(runDir, "gateway.log"), snapshot: path.join(runDir, "source-config.json"),
    metadata: path.join(runDir, "run.json") };
}
export function status(root = CONTROL_ROOT) {
  const lease = path.join(root, "lease.json");
  return fs.existsSync(lease) ? read(lease) : null;
}
function owned(root, id) {
  checkId(id);
  const lease = status(root);
  if (!lease || lease.runId !== id) throw new Error("E2E lease owner mismatch; refusing mutation");
  return { ...lease, ...paths(root, id) };
}
function proc() {
  if (!fs.existsSync("/proc")) return [];
  return fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).flatMap((p) => {
    try {
      const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8").split(") ").at(-1).split(" ");
      return [{ pid: Number(p), parent: Number(stat[1]), state: stat[0], start: stat[19],
        command: fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0")[0].trim(),
        env: fs.readFileSync(`/proc/${p}/environ`, "utf8").split("\0") }];
    } catch { return []; }
  });
}
async function freePorts() {
  const servers = [net.createServer(), net.createServer()];
  try {
    await Promise.all(servers.map((s) => new Promise((resolve, reject) => {
      s.once("error", reject); s.listen(0, "127.0.0.1", resolve);
    })));
    return servers.map((s) => s.address().port);
  } finally { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))); }
}
export async function acquire({ runId, owner, sourceRoot, containerId }, root = CONTROL_ROOT) {
  checkId(runId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const existing = status(root);
  if (existing) throw new Error(`E2E container is leased by ${existing.runId}; use --recover ${existing.runId} only after its runner exits`);
  if (proc().some((p) => p.state !== "Z" && p.command === "openclaw-gateway")) {
    throw new Error("E2E requires an idle dedicated container; existing Gateway will not be stopped");
  }
  if (!path.isAbsolute(sourceRoot)) throw new Error("source profile must be absolute");
  const p = paths(root, runId);
  fs.mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(p.requests, { mode: 0o700 });
  const bytes = fs.readFileSync(path.join(sourceRoot, "openclaw.json"));
  const snapshotFd = fs.openSync(p.snapshot, "wx", 0o600);
  try { fs.writeFileSync(snapshotFd, bytes); fs.fsyncSync(snapshotFd); } finally { fs.closeSync(snapshotFd); }
  const [gatewayPort, modelPort] = await freePorts();
  const record = { version: 1, runId, owner, sourceRoot, containerId, gatewayPort, modelPort,
    sourceConfigSha256: createHash("sha256").update(bytes).digest("hex"), phase: "acquired", createdAt: Date.now() };
  writeJson(p.metadata, record);
  // Also fail closed if a caller forgot the outer flock. Hard-link only a
  // complete, fsynced owner record; there is no empty-lock crash window.
  fs.linkSync(p.metadata, path.join(root, "lease.json"));
  return { ...record, ...p };
}
export function prepare(runId, root = CONTROL_ROOT) {
  const run = owned(root, runId);
  if (run.phase !== "acquired") throw new Error("E2E setup is not repeatable; refusing to overwrite a snapshot");
  const source = read(run.snapshot);
  const octo = source.channels?.octo;
  const accountId = Object.keys(octo?.accounts ?? {})[0];
  const account = accountId && octo.accounts[accountId];
  if (!account || account.enabled === false || typeof (account.botToken ?? octo.botToken) !== "string" || !(account.apiUrl ?? octo.apiUrl)) {
    throw new Error("first Octo account must be an enabled, explicitly configured test account");
  }
  if (source.plugins?.entries?.octo?.enabled === false) throw new Error("Octo is disabled in source profile");
  const main = source.agents?.entries?.main ?? source.agents?.list?.find((a) => a.id === "main");
  const privateMain = main ? { workspace: path.join(run.profile, "workspace"), agentDir: path.join(run.profile, "agents/main/agent"),
    ...(main.tools ? { tools: main.tools } : {}), ...(main.subagents ? { subagents: main.subagents } : {}),
  } : undefined;
  if ((source.tools?.exec?.host && source.tools.exec.host !== "gateway") ||
      (source.agents?.defaults?.sandbox?.mode && source.agents.defaults.sandbox.mode !== "off") ||
      (main?.sandbox?.mode && main.sandbox.mode !== "off")) {
    throw new Error("fixture requires Gateway-local tools; source execution policy is not overridden");
  }
  const workspace = path.join(run.profile, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const config = {
    gateway: { mode: "local", bind: "loopback", port: run.gatewayPort, auth: { mode: "token", token: `synthetic-${runId}` } },
    plugins: { allow: ["octo", "octo-host-e2e"], entries: {
      octo: { ...source.plugins?.entries?.octo },
      "octo-host-e2e": { enabled: true, hooks: { allowConversationAccess: true }, config: {
        runId, requestRoot: run.requests, stateRoot: run.profile, gatewayLog: run.gatewayLog, modelPort: run.modelPort,
      } },
    } },
    channels: { octo: { ...octo, docTasks: false, botTasks: false, accounts: { [accountId]: {
      ...account, botToken: account.botToken ?? octo.botToken, apiUrl: account.apiUrl ?? octo.apiUrl,
      docTasks: false, botTasks: false, wsUrl: `ws://127.0.0.1:${run.modelPort}/runs/${runId}/ws?account=${encodeURIComponent(accountId)}`,
    } } } },
    session: { dmScope: "per-account-channel-peer" },
    tools: { ...source.tools, toolSearch: false },
    models: { providers: { "octo-e2e": { baseUrl: `http://127.0.0.1:${run.modelPort}/runs/${runId}/v1`,
      apiKey: "synthetic-model-key", request: { allowPrivateNetwork: true }, models: [{ id: "scripted", name: "E2E Scripted",
        api: "openai-completions", reasoning: true, contextWindow: 131072, maxTokens: 4096 }] } } },
    agents: { defaults: { workspace, model: { primary: "octo-e2e/scripted" }, thinkingDefault: "low", reasoningDefault: "stream",
      ...(source.agents?.defaults?.subagents ? { subagents: source.agents.defaults.subagents } : {}),
    }, ...(privateMain ? (source.agents?.entries ? { entries: { main: privateMain } } : { list: [{ id: "main", ...privateMain }] }) : {}) },
  };
  writeJson(path.join(run.profile, "openclaw.json"), config);
  const next = { ...read(run.metadata), phase: "prepared", accountId };
  writeJson(run.metadata, next); writeJson(path.join(root, "lease.json"), next);
  return { ...next, ...paths(root, runId) };
}
export function mark(runId, phase, root = CONTROL_ROOT) {
  const run = owned(root, runId);
  const next = { ...read(run.metadata), phase };
  writeJson(run.metadata, next); writeJson(path.join(root, "lease.json"), next);
  return { ...next, ...paths(root, runId) };
}
export async function dispose(runId, root = CONTROL_ROOT) {
  const run = owned(root, runId);
  mark(runId, "disposing", root);
  const identities = new Map();
  function discover() {
    const all = proc();
    for (const p of all) if (p.env.includes(`OCTO_E2E_RUN_ID=${runId}`) && p.env.includes(`OPENCLAW_STATE_DIR=${run.profile}`)) identities.set(p.pid, p.start);
    let added = true;
    while (added) { added = false; for (const p of all) {
      if (all.some((q) => q.pid === p.parent && identities.get(q.pid) === q.start) && !identities.has(p.pid)) { identities.set(p.pid, p.start); added = true; }
    } }
    return all.filter((p) => p.state !== "Z" && identities.get(p.pid) === p.start);
  }
  const signal = (items, sig) => { for (const p of items) {
    if (proc().some((q) => q.pid === p.pid && q.start === p.start && q.state !== "Z")) {
      try { process.kill(p.pid, sig); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
  } };
  signal(discover(), "SIGTERM");
  const end = Date.now() + 5000;
  while (discover().length && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  signal(discover(), "SIGKILL");
  for (let i = 0; i < 20 && discover().length; i++) await new Promise((r) => setTimeout(r, 100));
  if (discover().length) throw new Error("owned processes remain; lease retained for recovery");
  // Original profile/config/dist/sessions were never written. Delete only the
  // recomputed private paths of the exact lease owner, never paths from JSON.
  fs.rmSync(run.profile, { recursive: true, force: true });
  fs.rmSync(run.snapshot, { force: true });
  writeJson(run.metadata, { ...read(run.metadata), phase: "cleaned", finishedAt: Date.now() });
  if (status(root)?.runId !== runId) throw new Error("lease changed during disposal");
  fs.unlinkSync(path.join(root, "lease.json"));
  return { runId, cleaned: true, artifacts: run.runDir };
}

if (process.argv[1] === "--control") {
  const arg = JSON.parse(process.argv[2]);
  const root = arg.controlRoot ?? CONTROL_ROOT;
  try {
    const value = arg.action === "status" ? status(root)
      : arg.action === "acquire" ? await acquire(arg, root)
      : arg.action === "prepare" ? prepare(arg.runId, root)
      : arg.action === "mark" ? mark(arg.runId, arg.phase, root)
      : arg.action === "dispose" ? await dispose(arg.runId, root)
      : (() => { throw new Error("unknown control operation"); })();
    process.stdout.write(JSON.stringify(value) + "\n");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
