// Container-local E2E resource ledger. The runner invokes every operation under
// Linux flock; the persistent lease survives runner SIGKILL/container restart.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CONTROL_ROOT = "/var/lib/octo-host-e2e";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkId(id) { if (!uuid.test(id)) throw new Error("invalid E2E run id"); }
function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function directoryIdentity(dir) {
  const stat = fs.lstatSync(dir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("refusing a non-directory or symlink E2E path");
  return { device: String(stat.dev), inode: String(stat.ino), birth: String(stat.birthtimeNs) };
}
function existsNoFollow(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function sameRun(a, b) {
  return ["version", "runId", "createdAt", "owner", "sourceRoot", "containerId", "sourceConfigSha256", "directoryIdentity"]
    .every((key) => isDeepStrictEqual(a[key], b[key]));
}
function verifyDirectory(root, run, allowAbsent = false) {
  directoryIdentity(root); directoryIdentity(path.join(root, "runs"));
  if (!run.directoryIdentity) throw new Error("lease has no directory ownership identity; manual inspection required");
  if (allowAbsent && !existsNoFollow(run.runDir)) return;
  if (!isDeepStrictEqual(directoryIdentity(run.runDir), run.directoryIdentity)) throw new Error("E2E run directory identity changed; refusing deletion");
}
function verifyMetadata(run) {
  const stat = fs.lstatSync(run.metadata);
  if (!stat.isFile() || stat.isSymbolicLink() || !sameRun(read(run.metadata), run)) throw new Error("E2E metadata owner mismatch; refusing deletion");
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDirectory(path.dirname(file));
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
  const bytes = fs.readFileSync(path.join(sourceRoot, "openclaw.json"));
  const [gatewayPort, modelPort] = await freePorts();
  const p = paths(root, runId);
  directoryIdentity(root);
  fs.mkdirSync(path.dirname(p.runDir), { recursive: true, mode: 0o700 });
  directoryIdentity(path.dirname(p.runDir));
  // Never claim a pre-existing UUID directory, even if it has no metadata.
  fs.mkdirSync(p.runDir, { mode: 0o700 });
  const identity = directoryIdentity(p.runDir);
  try {
    fs.mkdirSync(p.requests, { mode: 0o700 });
    const snapshotFd = fs.openSync(p.snapshot, "wx", 0o600);
    try { fs.writeFileSync(snapshotFd, bytes); fs.fsyncSync(snapshotFd); } finally { fs.closeSync(snapshotFd); }
    const record = { version: 1, runId, owner, sourceRoot, containerId, gatewayPort, modelPort,
      directoryIdentity: identity, sourceConfigSha256: createHash("sha256").update(bytes).digest("hex"), phase: "acquired", createdAt: Date.now() };
    writeJson(p.metadata, record);
    // Link only a complete fsynced record; even a caller without flock cannot
    // overwrite another run's lease. A losing candidate removes only itself.
    fs.linkSync(p.metadata, path.join(root, "lease.json"));
    return { ...record, ...p };
  } catch (error) {
    if (!isDeepStrictEqual(directoryIdentity(p.runDir), identity)) throw new AggregateError([error], `unleased candidate identity changed; inspect ${p.runDir}`);
    fs.rmSync(p.runDir, { recursive: true, force: true });
    throw error;
  }
}
// Test infrastructure only. Read the validator from the exact installed CLI/SDK,
// never a hand-written approximation of its schema or a second host version.
export async function loadHostConfigContract(hostRoot) {
  hostRoot = fs.realpathSync(hostRoot);
  const pkg = read(path.join(hostRoot, "package.json"));
  const dir = path.join(hostRoot, "dist");
  const candidates = fs.readdirSync(dir).filter((name) => /^(validation-core-|io\.types-).*\.m?js$/.test(name)).flatMap((name) => {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    const alias = source.match(/\bvalidateConfigObject as (\w+)/)?.[1];
    return alias && source.includes("function validateConfigObject(") ? [{ name, alias }] : [];
  });
  if (candidates.length !== 1) throw new Error(`cannot verify installed OpenClaw ${pkg.version} config contract; refusing E2E setup`);
  const { name, alias } = candidates[0];
  const validate = (await import(pathToFileURL(path.join(dir, name)).href))[alias];
  if (typeof validate !== "function") throw new Error("installed host validator unavailable; refusing E2E setup");
  const buildInfo = path.join(dir, "build-info.json");
  const sourceCommit = fs.existsSync(buildInfo) ? read(buildInfo).commit : undefined;
  return { version: pkg.version, sourceCommit, hostRoot, cliEntry: fs.realpathSync(path.join(hostRoot, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.openclaw)), validate };
}
function validateOrThrow(contract, config, label, profile) {
  const result = contract.validate(config, { env: { ...process.env, OPENCLAW_STATE_DIR: profile } });
  if (!result.ok) throw new Error(`${label} rejected by OpenClaw ${contract.version} schema: ` +
    result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return result.config;
}
function knownFields(object, allowed, label) {
  for (const key of Object.keys(object ?? {})) if (!allowed.includes(key)) {
    throw new Error(`${label}.${key} cannot be preserved by this synthetic fixture; refusing E2E setup`);
  }
}
function checkSourcePolicy(source, main, sourceRoot) {
  // Rebuilding a profile changes model, identity/state and routing context. Only
  // a clean synthetic config with explicitly supported policy scopes is safe.
  knownFields(source, ["meta", "gateway", "plugins", "channels", "models", "agents", "tools"], "source");
  knownFields(source.gateway, ["mode", "bind", "port", "auth"], "gateway");
  knownFields(source.agents?.defaults, ["workspace", "cwd", "repoRoot", "model", "thinkingDefault", "reasoningDefault",
    "elevatedDefault", "sandbox", "skills", "subagents", "maxConcurrent", "timeoutSeconds", "contextLimits"], "agents.defaults");
  knownFields(main, ["id", "default", "name", "description", "workspace", "cwd", "agentDir", "model", "thinkingDefault",
    "reasoningDefault", "tools", "subagents", "sandbox", "skills", "embeddedAgent"], "agents.entries.main");
  knownFields(source.plugins, ["allow", "deny", "enabled", "entries"], "plugins");
  if (source.plugins?.enabled === false || ["octo", "octo-host-e2e"].some((id) => source.plugins?.deny?.includes(id)) ||
      (source.plugins?.allow && !source.plugins.allow.includes("octo")) ||
      Object.keys(source.plugins?.entries ?? {}).some((id) => id !== "octo")) {
    throw new Error("source plugin admission cannot be preserved by this fixture; refusing E2E setup");
  }
  for (const [label, tools] of [["tools", source.tools], ["agents.entries.main.tools", main?.tools]]) {
    if (Object.keys(tools?.byProvider ?? {}).length) {
      throw new Error(`${label}.byProvider cannot be preserved when replacing the model provider; refusing E2E setup`);
    }
    if (tools?.exec?.applyPatch?.allowModels?.length) {
      throw new Error(`${label}.exec.applyPatch.allowModels cannot be preserved when replacing the model; refusing E2E setup`);
    }
    if (tools?.exec?.host && !["gateway", "auto"].includes(tools.exec.host)) {
      throw new Error(`${label}.exec.host requires a different execution context; refusing E2E setup`);
    }
  }
  for (const file of ["exec-approvals.json", "state/openclaw.sqlite", "state/openclaw.sqlite-wal"]) {
    if (fs.existsSync(path.join(sourceRoot, file))) throw new Error(`source has persisted policy/state (${file}); a fresh config-only synthetic profile is required`);
  }
}
export async function prepare(runId, root = CONTROL_ROOT, { cliEntry } = {}) {
  const run = owned(root, runId);
  if (run.phase !== "acquired") throw new Error("E2E setup is not repeatable; refusing to overwrite a snapshot");
  const source = read(run.snapshot);
  const contract = await loadHostConfigContract(path.join(run.sourceRoot, "extensions/octo/node_modules/openclaw"));
  if (!cliEntry || fs.realpathSync(cliEntry) !== contract.cliEntry) throw new Error("Gateway CLI and plugin SDK must be the same exact host installation");
  const validated = validateOrThrow(contract, source, "source config", run.profile);
  const entries = Object.entries(validated.agents?.entries ?? {});
  if (entries.length !== 1 || entries[0][0].toLowerCase() !== "main") throw new Error("fixture requires exactly one configured main agent; other agent policies will not be discarded");
  const main = entries[0][1];
  checkSourcePolicy(source, main, run.sourceRoot);
  const octo = source.channels?.octo;
  const accountId = Object.keys(octo?.accounts ?? {})[0];
  const account = accountId && octo.accounts[accountId];
  if (!account || account.enabled === false || typeof (account.botToken ?? octo.botToken) !== "string" || !(account.apiUrl ?? octo.apiUrl)) {
    throw new Error("first Octo account must be an enabled, explicitly configured test account");
  }
  if (source.plugins?.entries?.octo?.enabled === false) throw new Error("Octo is disabled in source profile");
  const privateMain = { ...main, model: { primary: "octo-e2e/scripted" }, thinkingDefault: "low", reasoningDefault: "stream", workspace: path.join(run.profile, "workspace"), agentDir: path.join(run.profile, "agents/main/agent"),
    ...(main.cwd ? { cwd: path.join(run.profile, "workspace") } : {}),
  };
  if ((source.agents?.defaults?.sandbox?.mode && source.agents.defaults.sandbox.mode !== "off") ||
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
    agents: { ...(source.agents?.ownership ? { ownership: source.agents.ownership } : {}), defaults: { ...source.agents?.defaults, workspace,
      ...(source.agents?.defaults?.cwd ? { cwd: workspace } : {}), ...(source.agents?.defaults?.repoRoot ? { repoRoot: workspace } : {}), model: { primary: "octo-e2e/scripted" }, thinkingDefault: "low", reasoningDefault: "stream",
    }, entries: { main: privateMain } },
  };
  validateOrThrow(contract, config, "private config", run.profile);
  writeJson(path.join(run.profile, "openclaw.json"), config);
  const next = { ...read(run.metadata), phase: "prepared", accountId, hostVersion: contract.version, hostSourceCommit: contract.sourceCommit };
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
  checkId(runId);
  const p = paths(root, runId);
  if (!status(root)) {
    if (existsNoFollow(p.runDir)) throw new Error("unleased E2E directory cannot be proven owned; refusing deletion");
    return { runId, cleaned: true, alreadyRemoved: true };
  }
  const run = owned(root, runId);
  verifyDirectory(root, run, run.phase === "removing");
  // The durable removing phase permits recovery after partial rmtree or after
  // rmtree succeeded but releasing the lease failed. Metadata may be gone then.
  if (run.phase !== "removing") { verifyMetadata(run); mark(runId, "disposing", root); }
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
  const current = owned(root, runId);
  if (!sameRun(current, run)) throw new Error("lease changed during disposal");
  verifyDirectory(root, run, current.phase === "removing");
  if (current.phase !== "removing") { verifyMetadata(run); mark(runId, "removing", root); }
  // No retention after completed disposal, including ordinary failed tests.
  // Only the exclusive-created, inode-verified UUID directory is removed.
  fs.rmSync(run.runDir, { recursive: true, force: true });
  syncDirectory(path.dirname(run.runDir));
  const final = owned(root, runId);
  if (!sameRun(final, run) || final.phase !== "removing") throw new Error("lease changed during disposal");
  fs.unlinkSync(path.join(root, "lease.json"));
  return { runId, cleaned: true, removed: run.runDir };
}

if (process.argv[1] === "--control") {
  const arg = JSON.parse(process.argv[2]);
  const root = arg.controlRoot ?? CONTROL_ROOT;
  try {
    const value = arg.action === "status" ? status(root)
      : arg.action === "acquire" ? await acquire(arg, root)
      : arg.action === "prepare" ? await prepare(arg.runId, root, { cliEntry: arg.cliEntry })
      : arg.action === "mark" ? mark(arg.runId, arg.phase, root)
      : arg.action === "dispose" ? await dispose(arg.runId, root)
      : (() => { throw new Error("unknown control operation"); })();
    process.stdout.write(JSON.stringify(value) + "\n");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
