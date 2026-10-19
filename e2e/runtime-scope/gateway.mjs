// Run only in a disposable test environment. All peers and credentials below
// are synthetic; no configured Gateway, installed plugin or real account is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createSyntheticOcto, REPLY } from "./synthetic-octo.mjs";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const hostRoot = process.env.OCTO_RUNTIME_HOST_ROOT ?? path.resolve(path.dirname(require.resolve("openclaw/plugin-sdk/runtime-store")), "../..");
const { version } = JSON.parse(readFileSync(path.join(hostRoot, "package.json"), "utf8"));
const state = mkdtempSync(path.join(tmpdir(), "octo-runtime-gateway-"));
const server = await createSyntheticOcto();
const configPath = path.join(state, "openclaw.json");
const config = {
  gateway: { mode: "local", bind: "loopback", port: 19876, auth: { mode: "token", token: "synthetic-gateway-token" } },
  plugins: { allow: ["octo"], load: { paths: [repoRoot] }, entries: {
    octo: { enabled: true, hooks: { allowConversationAccess: true } },
  } },
  channels: { octo: { accounts: { scope: { enabled: true, botToken: "synthetic-token",
    apiUrl: server.baseUrl, docTasks: false, botTasks: false } } } },
  models: { providers: { "scope-probe": { baseUrl: `${server.baseUrl}/v1`, apiKey: "synthetic-model-key",
    request: { allowPrivateNetwork: true }, models: [{ id: "scripted", name: "Synthetic scope probe",
      api: "openai-completions", contextWindow: 131072, maxTokens: 512 }] } } },
  agents: { defaults: { workspace: path.join(state, "workspace"), model: { primary: "scope-probe/scripted" } } },
};
mkdirSync(config.agents.defaults.workspace, { recursive: true });
writeFileSync(configPath, JSON.stringify(config));
let output = "";
let deadline;
const child = spawn(process.execPath, [path.join(hostRoot, "openclaw.mjs"), "gateway", "run", "--allow-unconfigured"], {
  env: { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_UPDATE_CHECK: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (b) => { output += b.toString(); });
child.stderr.on("data", (b) => { output += b.toString(); });
const ended = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});
try {
  await Promise.race([server.delivered,
    ended.then((code) => { throw new Error(`Gateway exited ${code}\n${output}`); }),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Gateway delivery timeout\n${output}\nrequests=${server.requests}`)), 60_000); }),
  ]);
  assert.equal(server.agentVersion, version);
  assert.equal(server.acked, true);
  assert.ok(server.requests.includes("/v1/chat/completions"), "actual Agent must reach the synthetic model");
  assert.equal(server.sends.filter((s) => s.payload?.content === REPLY).length, 1);
  assert.deepEqual(server.unknown, []);
  console.log(`PASS actual Gateway ${version} / ${process.version}: startup -> Octo registration -> encrypted WebSocket inbound -> actual Agent dispatch with synthetic model -> one HTTP final`);
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  const stop = setTimeout(() => child.kill("SIGKILL"), 5000);
  await ended.catch(() => {});
  clearTimeout(stop);
  await server.close();
  if (process.env.OCTO_RUNTIME_KEEP_EVIDENCE === "1") {
    writeFileSync(path.join(state, "gateway.log"), output);
    console.log(`Synthetic evidence retained at ${state}`);
  } else rmSync(state, { recursive: true, force: true });
}
