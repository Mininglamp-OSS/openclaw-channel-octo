import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const supervisor = fileURLToPath(new URL("../scripts/openclaw-e2e-child.mjs", import.meta.url));
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.startsWith("Z")) return false;
    return true;
  } catch { return false; }
}
it("a separate supervisor stops its worker and grandchildren after runner SIGKILL", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "octo-supervisor-"));
  const receipt = path.join(dir, "owned.json");
  const worker = `const {spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.on('spawn',()=>fs.writeFileSync(process.argv[1],JSON.stringify({worker:process.pid,grandchild:c.pid})));setInterval(()=>{},1000);`;
  const ownerCode = `const {spawn}=require('node:child_process');spawn(process.execPath,[process.argv[1],String(process.pid),process.execPath,'-e',process.argv[2],process.argv[3]],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["-e", ownerCode, supervisor, worker, receipt], { stdio: "ignore" });
  let owned: {worker: number; grandchild: number} | undefined;
  try {
    for (let i = 0; i < 100 && !fs.existsSync(receipt); i++) await delay(50);
    owned = JSON.parse(fs.readFileSync(receipt, "utf8"));
    expect(alive(owned!.worker)).toBe(true); expect(alive(owned!.grandchild)).toBe(true);
    owner.kill("SIGKILL");
    for (let i = 0; i < 100 && (alive(owned!.worker) || alive(owned!.grandchild)); i++) await delay(50);
    expect(alive(owned!.worker)).toBe(false); expect(alive(owned!.grandchild)).toBe(false);
  } finally {
    owner.kill("SIGKILL");
    for (const pid of Object.values(owned ?? {})) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
