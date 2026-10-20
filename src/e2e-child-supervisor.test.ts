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

for (const exitCode of [0, 7]) it(`cleans TERM-resistant same-group descendants after worker exit ${exitCode}, preserving that status`, async () => {
  const dir=fs.mkdtempSync(path.join(tmpdir(),"octo-supervisor-exit-")),receipt=path.join(dir,"grandchild.pid");
  const grandchild="const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);";
  const worker="const {spawn}=require('child_process'),fs=require('fs');spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);process.exit(Number(process.argv[3]));}},10);";
  const child=spawn(process.execPath,[supervisor,String(process.pid),process.execPath,"-e",worker,grandchild,receipt,String(exitCode)],{stdio:"ignore"});
  const ended=new Promise<number|null>(resolve=>child.once("exit",resolve));
  const unrelated=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
  let pid:number|undefined;
  try {
    for(let i=0;i<100&&!fs.existsSync(receipt);i++)await delay(30);
    pid=Number(fs.readFileSync(receipt,"utf8"));expect(pid).toBeGreaterThan(0);
    expect(await ended).toBe(exitCode);
    for(let i=0;i<50&&alive(pid);i++)await delay(30);
    expect(alive(pid)).toBe(false);expect(alive(unrelated.pid!)).toBe(true);
  } finally {
    child.kill("SIGKILL");unrelated.kill("SIGKILL");if(pid){try{process.kill(pid,"SIGKILL");}catch{}}
    fs.rmSync(dir,{recursive:true,force:true});
  }
},10000);
