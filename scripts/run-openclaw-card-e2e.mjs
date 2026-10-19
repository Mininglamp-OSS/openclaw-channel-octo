#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stateSource = readFileSync(new URL("./openclaw-e2e-state.mjs", import.meta.url), "utf8");
const controlRoot = "/var/lib/octo-host-e2e";
const container = process.env.OCTO_E2E_CONTAINER?.trim();
const sourceRoot = process.env.OCTO_E2E_STATE_ROOT ?? "/root/.openclaw-dev";
const targetUid = process.env.OCTO_E2E_TARGET_UID?.trim();
const recoverAt = process.argv.indexOf("--recover");
const recoverId = recoverAt >= 0 ? process.argv[recoverAt + 1] : undefined;
let interrupted;
let child;
let wakeGate;
const abort = (signal) => {
  interrupted ??= signal;
  wakeGate?.();
  if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => abort(sig));
const info = (s) => console.log(`[openclaw-e2e] ${s}`);
function check() { if (interrupted) throw new Error(`runner interrupted by ${interrupted}`); }
async function docker(args) { return await exec("docker", args, { cwd: repoRoot, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }); }
async function control(arg) {
  await docker(["exec", container, "mkdir", "-p", "-m", "700", controlRoot]);
  const { stdout } = await docker(["exec", container, "flock", "-n", `${controlRoot}/operations.lock`,
    "node", "--input-type=module", "-e", stateSource, "--", "--control", JSON.stringify(arg)]);
  return JSON.parse(stdout);
}
async function stamp(pid) {
  try { return (await exec("ps", ["-o", "lstart=", "-p", String(pid)])).stdout.trim(); } catch { return ""; }
}
const hostId = `${hostname()}:${userInfo().uid}`;
async function recover() {
  const lease = await control({ action: "status" });
  if (!lease || lease.runId !== recoverId) throw new Error("recovery token does not match the persistent lease");
  if (lease.owner.hostId !== hostId) throw new Error("cannot verify another host's runner; lease retained for manual inspection");
  const birth = await stamp(lease.owner.pid);
  if (birth && birth === lease.owner.birth) throw new Error("lease runner is still alive; refusing recovery");
  const id = JSON.parse((await docker(["inspect", container, "--format", "{{json .Id}}"])).stdout);
  if (id !== lease.containerId) throw new Error("container identity changed; refusing recovery");
  info(JSON.stringify(await control({ action: "dispose", runId: recoverId })));
}
async function streaming(file, args, env = process.env) {
  check();
  await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(repoRoot, "scripts/openclaw-e2e-child.mjs"), String(process.pid), file, ...args],
      { cwd: repoRoot, env, stdio: "inherit", detached: true });
    const owned = child;
    const force = () => { try { process.kill(-owned.pid, "SIGKILL"); } catch {} };
    let timer;
    const monitor = setInterval(() => { if (interrupted && !timer) timer = setTimeout(force, 3000); }, 100);
    owned.once("error", (error) => { clearInterval(monitor); clearTimeout(timer); child = undefined; reject(error); });
    owned.once("exit", (code, signal) => {
      clearInterval(monitor); clearTimeout(timer); child = undefined;
      code === 0 ? resolve() : reject(new Error(`${file} exited with ${signal ?? code}`));
    });
  });
  check();
}
async function install(run) {
  const octo = `${run.profile}/extensions/octo`;
  const bridge = `${run.profile}/extensions/octo-host-e2e`;
  await docker(["exec", container, "mkdir", "-p", octo, bridge]);
  for (const rel of ["package.json", "openclaw.plugin.json", "index.ts", "setup-entry.ts", "dist", "skills"]) {
    check(); await docker(["cp", path.join(repoRoot, rel), `${container}:${octo}/${rel}`]);
  }
  await docker(["cp", `${path.join(repoRoot, "e2e/openclaw-host-plugin")}/.` , `${container}:${bridge}/`]);
  await docker(["exec", container, "ln", "-s", `${sourceRoot}/extensions/octo/node_modules`, `${octo}/node_modules`]);
  await docker(["exec", container, "ln", "-s", `${octo}/node_modules`, `${bridge}/node_modules`]);
  await docker(["exec", container, "chown", "-R", "root:root", `${run.profile}/extensions`]);
}
async function start(run) {
  check();
  await control({ action: "mark", runId: run.runId, phase: "starting" });
  const launch = `const fs=require('fs'),{spawn}=require('child_process');const fd=fs.openSync(process.argv[1],'a');const c=spawn('openclaw',['--dev','gateway','run','--allow-unconfigured'],{env:process.env,stdio:['ignore',fd,fd]});c.unref();fs.closeSync(fd);`;
  await docker(["exec", "-d", "-e", `OPENCLAW_STATE_DIR=${run.profile}`, "-e", `OPENCLAW_CONFIG_PATH=${run.profile}/openclaw.json`,
    "-e", "OPENCLAW_NO_RESPAWN=1", "-e", "OPENCLAW_SKIP_UPDATE_CHECK=1", "-e", `OCTO_E2E_RUN_ID=${run.runId}`,
    "-e", "OCTO_CARD_DEBUG=1", container, "node", "-e", launch, run.gatewayLog]);
  let lastLog = "";
  for (let i = 0; i < 60; i++) {
    check();
    const { stdout } = await docker(["exec", container, "node", "-e", "const fs=require('fs');try{process.stdout.write(fs.readFileSync(process.argv[1],'utf8'))}catch{}", run.gatewayLog]);
    lastLog = stdout;
    if (stdout.includes("[gateway] ready") && stdout.includes("octo-host-e2e: request bridge ready")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (lastLog) console.error(`[openclaw-e2e] startup log tail before cleanup:\n${lastLog.slice(-16_384)}`);
  throw new Error("private Gateway failed to become ready");
}
async function gate(phase, run) {
  if (process.env.OCTO_E2E_TEST_GATE !== phase) return;
  // Fault-injection hook for the isolated infrastructure tests. SIGKILL cannot
  // run a handler: the durable lease + explicit --recover handles that case.
  await control({ action: "mark", runId: run.runId, phase: `test-gate-${phase}` });
  info(`TEST_GATE ${phase} run=${run.runId}`);
  await new Promise((r) => {
    const hold = setInterval(() => {}, 1000);
    wakeGate = () => { clearInterval(hold); r(); };
    if (interrupted) wakeGate();
  });
  check();
}
async function main() {
  if (!container) throw new Error("OCTO_E2E_CONTAINER must explicitly name an idle disposable test container");
  if (recoverAt >= 0) { if (!recoverId) throw new Error("--recover requires the exact run UUID"); await recover(); return; }
  if (!targetUid) throw new Error("OCTO_E2E_TARGET_UID is required");
  const containerId = JSON.parse((await docker(["inspect", container, "--format", "{{json .Id}}"])).stdout);
  check();
  let run;
  let failure;
  try {
    run = await control({ action: "acquire", runId: randomUUID(), sourceRoot, containerId,
      owner: { hostId, pid: process.pid, birth: await stamp(process.pid) } });
    info(`run=${run.runId} temp=${run.runDir}`);
    check();
    const cliEntry = (await docker(["exec", container, "which", "openclaw"])).stdout.trim();
    run = await control({ action: "prepare", runId: run.runId, cliEntry });
    await streaming("npm", ["run", "build"]);
    check();
    await install(run);
    await gate("prepared", run);
    await start(run);
    await gate("ready", run);
    const args = ["vitest", "run", "src/card-openclaw-e2e.test.ts", "--reporter=verbose", "--bail=1"];
    if (process.env.OCTO_E2E_TEST_NAME?.trim()) args.push("-t", process.env.OCTO_E2E_TEST_NAME.trim());
    await streaming("npx", args, { ...process.env, OCTO_OPENCLAW_E2E: "1", OCTO_E2E_CONTAINER: container,
      OCTO_E2E_TARGET_UID: targetUid, OCTO_E2E_RUN_ID: run.runId, OCTO_E2E_REQUEST_ROOT: run.requests,
      OCTO_E2E_PROFILE: run.profile, OCTO_E2E_GATEWAY_LOG: run.gatewayLog });
  } catch (error) { failure = error; }
  if (run) {
    try { info(JSON.stringify(await control({ action: "dispose", runId: run.runId }))); }
    catch (error) {
      console.error(`cleanup incomplete; lease retained. Recover with --recover ${run.runId}: ${error.message}`);
      failure ??= error;
    }
  }
  if (failure) throw failure;
  info("GREEN; private run removed, source profile was never modified");
}
main().catch((e) => { console.error(`[openclaw-e2e] ${e.message}`); process.exitCode = 1; });
