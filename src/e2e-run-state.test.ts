import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { acquire, prepare, dispose, status, mark, loadHostConfigContract } from "../scripts/openclaw-e2e-state.mjs";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "octo-run-state-")); dirs.push(dir);
  const sourceRoot = path.join(dir, "source"); fs.mkdirSync(sourceRoot);
  const source = { tools: { deny: ["dangerous-tool"] }, agents: { defaults: { workspace: "/must-not-write" } },
    plugins: { entries: { octo: { hooks: { allowConversationAccess: true } } } },
    channels: { octo: { accounts: { scope: { enabled: true, botToken: "synthetic", apiUrl: "http://fake.invalid" } } } } };
  const hostRoot = fileURLToPath(new URL("../node_modules/openclaw", import.meta.url));
  fs.mkdirSync(path.join(sourceRoot, "extensions/octo/node_modules"), { recursive: true });
  fs.symlinkSync(hostRoot, path.join(sourceRoot, "extensions/octo/node_modules/openclaw"));
  const cliEntry = path.join(hostRoot, "openclaw.mjs");
  const bytes = JSON.stringify(source); fs.writeFileSync(path.join(sourceRoot, "openclaw.json"), bytes);
  return { root: path.join(dir, "control"), sourceRoot, bytes, cliEntry,
    arg: { runId: randomUUID(), owner: { hostId: "test", pid: 1, birth: "test" }, sourceRoot, containerId: "fake-container" } };
}
it("exclusive acquisition precedes mutation and cannot overwrite another owner's backup", async () => {
  const f = fixture(); const run = await acquire(f.arg, f.root);
  await expect(acquire({ ...f.arg, runId: randomUUID() }, f.root)).rejects.toThrow(/leased/);
  expect(fs.readFileSync(run.snapshot, "utf8")).toBe(f.bytes);
  expect(fs.readFileSync(path.join(f.sourceRoot, "openclaw.json"), "utf8")).toBe(f.bytes);
  await dispose(run.runId, f.root);
});
it("refuses an empty initial birth before creating any control resources", async () => {
  const f=fixture();await expect(acquire({...f.arg,owner:{...f.arg.owner,birth:""}},f.root)).rejects.toThrow(/nonempty owner birth/);
  expect(fs.existsSync(f.root)).toBe(false);
});
it("simultaneous acquisitions cannot both win even before the outer flock", async () => {
  const f = fixture(); const results = await Promise.allSettled([acquire(f.arg, f.root), acquire({ ...f.arg, runId: randomUUID() }, f.root)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const lease = status(f.root); expect([f.arg.runId, ...results.flatMap((r) => r.status === "fulfilled" ? [r.value.runId] : [])]).toContain(lease.runId);
  await dispose(lease.runId, f.root);
});
it("private setup isolates configuration, sessions/workspace and preserves restrictions", async () => {
  const f = fixture(); const run = await acquire(f.arg, f.root); const prepared = await prepare(run.runId, f.root, { cliEntry: f.cliEntry });
  const cfg = JSON.parse(fs.readFileSync(path.join(prepared.profile, "openclaw.json"), "utf8"));
  expect(cfg.tools.deny).toEqual(["dangerous-tool"]);
  expect(cfg.agents.defaults.workspace).toBe(path.join(prepared.profile, "workspace"));
  expect(cfg.session.store).toBeUndefined();
  expect(fs.readFileSync(path.join(f.sourceRoot, "openclaw.json"), "utf8")).toBe(f.bytes);
  await expect(prepare(run.runId, f.root, { cliEntry: f.cliEntry })).rejects.toThrow(/not repeatable/);
  await dispose(run.runId, f.root);
  expect(fs.existsSync(prepared.profile)).toBe(false);
});
it("foreign/stale recovery tokens cannot remove another run; disposal works from durable state", async () => {
  const f = fixture(); const run = await acquire(f.arg, f.root); await prepare(run.runId, f.root, { cliEntry: f.cliEntry });
  await expect(dispose(randomUUID(), f.root)).rejects.toThrow(/owner mismatch/);
  expect(status(f.root).runId).toBe(run.runId);
  await dispose(run.runId, f.root); expect(status(f.root)).toBeNull();
  expect(fs.readFileSync(path.join(f.sourceRoot, "openclaw.json"), "utf8")).toBe(f.bytes);
  const next = await acquire({ ...f.arg, runId: randomUUID() }, f.root);
  await expect(dispose(run.runId, f.root)).rejects.toThrow(/owner mismatch/);
  expect(status(f.root).runId).toBe(next.runId); await dispose(next.runId, f.root);
});

for (const layout of ["entries", "list"]) it(`preserves main-agent tool restrictions in ${layout} source layout`, async () => {
  const f = fixture(); const source = JSON.parse(f.bytes);
  const main = { tools: { deny: ["exec"] }, subagents: { allowAgents: ["main"] } };
  source.agents[layout] = layout === "entries" ? { main } : [{ id: "main", ...main }];
  fs.writeFileSync(path.join(f.sourceRoot, "openclaw.json"), JSON.stringify(source));
  const run = await acquire(f.arg, f.root);
  const contract = await loadHostConfigContract(path.dirname(f.cliEntry));
  const accepted = contract.validate(source);
  if (layout === "list" && !accepted.ok) {
    expect(accepted.issues.some((issue: {path: string}) => issue.path === "agents.list")).toBe(true);
    await expect(prepare(run.runId, f.root, { cliEntry: f.cliEntry })).rejects.toThrow(/source config rejected/);
    expect(fs.existsSync(path.join(run.profile, "openclaw.json"))).toBe(false);
    expect(fs.readFileSync(path.join(f.sourceRoot,"openclaw.json"),"utf8")).toBe(JSON.stringify(source));
    await dispose(run.runId,f.root);return;
  }
  expect(accepted.ok).toBe(true);
  const prepared = await prepare(run.runId, f.root, { cliEntry: f.cliEntry });
  const cfg = JSON.parse(fs.readFileSync(path.join(prepared.profile, "openclaw.json"), "utf8"));
  const actual = cfg.agents.entries.main;
  expect(actual.tools).toEqual(main.tools); expect(actual.subagents).toEqual(main.subagents);
  expect(actual.workspace).toBe(path.join(prepared.profile, "workspace"));
  await dispose(run.runId, f.root);
});

function seedArtifacts(run: {profile: string; requests: string; gatewayLog: string}) {
  fs.mkdirSync(run.profile, {recursive:true});
  fs.writeFileSync(path.join(run.profile,"synthetic-secret.json"),"synthetic-only");
  fs.writeFileSync(path.join(run.requests,"request.json"),"synthetic request");
  fs.writeFileSync(path.join(run.requests,"result.json"),"synthetic result");
  fs.writeFileSync(run.gatewayLog,"synthetic gateway log");
}
for (const phase of ["passed", "failed"]) it(`completed disposal removes every artifact after a ${phase} test`, async () => {
  const f=fixture(); const run=await acquire(f.arg,f.root); seedArtifacts(run); mark(run.runId,phase,f.root);
  const other=path.join(f.root,"runs",randomUUID());fs.mkdirSync(other);fs.writeFileSync(path.join(other,"user-existing"),"keep");
  // Recursive removal must unlink this child link, never traverse its target.
  fs.symlinkSync(f.sourceRoot,path.join(run.requests,"source-link"));
  expect(await dispose(run.runId,f.root)).toMatchObject({cleaned:true,removed:run.runDir});
  expect(fs.existsSync(run.runDir)).toBe(false); expect(status(f.root)).toBeNull();
  expect(fs.readFileSync(path.join(other,"user-existing"),"utf8")).toBe("keep");
  expect(fs.readFileSync(path.join(f.sourceRoot,"openclaw.json"),"utf8")).toBe(f.bytes);
});
it("repeated completed cleanup is a no-op and cannot touch a subsequent active owner", async () => {
  const f=fixture();const first=await acquire(f.arg,f.root);seedArtifacts(first);await dispose(first.runId,f.root);
  expect(await dispose(first.runId,f.root)).toMatchObject({cleaned:true,alreadyRemoved:true});
  const second=await acquire({...f.arg,runId:randomUUID()},f.root);seedArtifacts(second);
  await expect(dispose(first.runId,f.root)).rejects.toThrow(/owner mismatch/);
  expect(status(f.root).runId).toBe(second.runId);
  expect(fs.readFileSync(path.join(second.requests,"result.json"),"utf8")).toBe("synthetic result");
  await dispose(second.runId,f.root);
});
it("partial directory-removal failure retains a recoverable lease even after metadata disappears", async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);seedArtifacts(run);
  const original=fs.rmSync.bind(fs);let injected=false;
  const spy=vi.spyOn(fs,"rmSync").mockImplementation((file,options)=>{
    if(String(file)===run.runDir&&!injected){injected=true;original(run.metadata);throw new Error("synthetic rmtree failure");}
    return original(file,options);
  });
  await expect(dispose(run.runId,f.root)).rejects.toThrow(/synthetic rmtree failure/);
  expect(status(f.root)).toMatchObject({runId:run.runId,phase:"removing",directoryIdentity:run.directoryIdentity});
  expect(fs.existsSync(run.runDir)).toBe(true);expect(fs.existsSync(run.metadata)).toBe(false);
  spy.mockRestore();await dispose(run.runId,f.root);
  expect(fs.existsSync(run.runDir)).toBe(false);expect(status(f.root)).toBeNull();
});
it("lease-release failure after deletion can be retried with the directory already absent", async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);seedArtifacts(run);
  const original=fs.unlinkSync.bind(fs);const spy=vi.spyOn(fs,"unlinkSync").mockImplementation(file=>{
    if(String(file)===path.join(f.root,"lease.json"))throw new Error("synthetic lease release failure");
    return original(file);
  });
  await expect(dispose(run.runId,f.root)).rejects.toThrow(/synthetic lease release failure/);
  expect(fs.existsSync(run.runDir)).toBe(false);expect(status(f.root).phase).toBe("removing");
  spy.mockRestore();await dispose(run.runId,f.root);expect(status(f.root)).toBeNull();
});
for (const replacement of ["directory", "symlink"]) it(`refuses a run directory replaced by another ${replacement}`, async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);const saved=run.runDir+"-owned";
  fs.renameSync(run.runDir,saved);
  const target=path.join(path.dirname(f.root),"unrelated");fs.mkdirSync(target);fs.writeFileSync(path.join(target,"keep"),"untouched");
  if(replacement==="symlink")fs.symlinkSync(target,run.runDir);else{fs.mkdirSync(run.runDir);fs.writeFileSync(path.join(run.runDir,"keep"),"untouched");}
  await expect(dispose(run.runId,f.root)).rejects.toThrow(/identity changed|symlink/);
  expect(status(f.root).runId).toBe(run.runId);expect(fs.readFileSync(path.join(target,"keep"),"utf8")).toBe("untouched");
  if(replacement==="directory")expect(fs.readFileSync(path.join(run.runDir,"keep"),"utf8")).toBe("untouched");
  fs.rmSync(run.runDir,{recursive:true,force:true});fs.renameSync(saved,run.runDir);await dispose(run.runId,f.root);
});
it("refuses foreign metadata without changing the lease or deleting artifacts", async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);seedArtifacts(run);mark(run.runId,"prepared",f.root);const bytes=fs.readFileSync(run.metadata,"utf8");
  fs.writeFileSync(run.metadata,JSON.stringify({...JSON.parse(bytes),owner:{hostId:"foreign",pid:999,birth:"other"}}));
  await expect(dispose(run.runId,f.root)).rejects.toThrow(/metadata owner mismatch/);
  expect(status(f.root).phase).toBe("prepared");expect(fs.existsSync(run.gatewayLog)).toBe(true);
  fs.writeFileSync(run.metadata,bytes);await dispose(run.runId,f.root);
});
it("never claims or sweeps a pre-existing UUID directory", async () => {
  const f=fixture();const dir=path.join(f.root,"runs",f.arg.runId);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"keep"),"user-existing");
  await expect(acquire(f.arg,f.root)).rejects.toThrow(/EEXIST/);
  expect(fs.readFileSync(path.join(dir,"keep"),"utf8")).toBe("user-existing");expect(fs.existsSync(path.join(dir,"run.json"))).toBe(false);
  await expect(dispose(f.arg.runId,f.root)).rejects.toThrow(/unleased/);expect(fs.existsSync(path.join(dir,"keep"))).toBe(true);
});
it("a losing acquisition cleans its own candidate without removing the winning run", async () => {
  const f=fixture();const results=await Promise.allSettled([acquire(f.arg,f.root),acquire({...f.arg,runId:randomUUID()},f.root)]);
  const winner=results.flatMap(r=>r.status==="fulfilled"?[r.value]:[])[0];
  expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  expect(fs.readdirSync(path.join(f.root,"runs"))).toEqual([winner.runId]);expect(status(f.root).runId).toBe(winner.runId);
  await dispose(winner.runId,f.root);
});

it("legacy leases without creation identity are retained for manual inspection", async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);seedArtifacts(run);mark(run.runId,"prepared",f.root);
  const leasePath=path.join(f.root,"lease.json"),metadata=fs.readFileSync(run.metadata,"utf8"),lease=fs.readFileSync(leasePath,"utf8");
  const old=JSON.parse(lease);delete old.directoryIdentity;fs.writeFileSync(leasePath,JSON.stringify(old));fs.writeFileSync(run.metadata,JSON.stringify(old));
  await expect(dispose(run.runId,f.root)).rejects.toThrow(/ownership identity.*manual inspection/);
  expect(fs.existsSync(run.gatewayLog)).toBe(true);expect(status(f.root).runId).toBe(run.runId);
  fs.writeFileSync(leasePath,lease);fs.writeFileSync(run.metadata,metadata);await dispose(run.runId,f.root);
});

for (const dangling of [false, true]) it(`refuses a ${dangling ? "dangling" : "live"} lease symlink before reading or mutating anything`, async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);seedArtifacts(run);
  const lease=path.join(f.root,"lease.json"),saved=lease+".saved",target=path.join(f.sourceRoot,"foreign.json");
  if(!dangling)fs.writeFileSync(target,"not ownership JSON");
  fs.renameSync(lease,saved);fs.symlinkSync(target,lease);
  const reader=vi.spyOn(fs,"readFileSync");
  expect(()=>status(f.root)).toThrow(/ELOOP|symbolic link/i);expect(reader).not.toHaveBeenCalled();
  await expect(dispose(run.runId,f.root)).rejects.toThrow(/ELOOP|symbolic link/i);
  expect(reader).not.toHaveBeenCalled();reader.mockRestore();
  expect(fs.lstatSync(lease).isSymbolicLink()).toBe(true);expect(fs.existsSync(run.gatewayLog)).toBe(true);
  if(!dangling)expect(fs.readFileSync(target,"utf8")).toBe("not ownership JSON");
  fs.unlinkSync(lease);fs.renameSync(saved,lease);await dispose(run.runId,f.root);
});
it("rejects a non-regular lease without reading it", async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);const lease=path.join(f.root,"lease.json"),saved=lease+".saved";
  fs.renameSync(lease,saved);fs.mkdirSync(lease);
  const reader=vi.spyOn(fs,"readFileSync");
  expect(()=>status(f.root)).toThrow(/regular file/);expect(reader).not.toHaveBeenCalled();reader.mockRestore();
  fs.rmdirSync(lease);fs.renameSync(saved,lease);await dispose(run.runId,f.root);
});
it("reads the opened lease descriptor if the pathname is replaced after open", async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);const lease=path.join(f.root,"lease.json"),saved=lease+".saved";
  const target=path.join(f.sourceRoot,"foreign.json");fs.writeFileSync(target,"not ownership JSON");
  const original=fs.openSync.bind(fs);let replaced=false;
  const spy=vi.spyOn(fs,"openSync").mockImplementation((file,flags,mode)=>{
    const fd=original(file,flags,mode);
    if(String(file)===lease&&!replaced){replaced=true;fs.renameSync(lease,saved);fs.symlinkSync(target,lease);}
    return fd;
  });
  expect(status(f.root).runId).toBe(run.runId);expect(replaced).toBe(true);spy.mockRestore();
  expect(()=>status(f.root)).toThrow(/ELOOP|symbolic link/i);
  fs.unlinkSync(lease);fs.renameSync(saved,lease);await dispose(run.runId,f.root);
});
for (const action of ["mark", "prepare", "dispose"]) it(`refuses symlink metadata before ${action}`, async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);const saved=run.metadata+".saved";
  fs.renameSync(run.metadata,saved);fs.symlinkSync(saved,run.metadata);
  if(action==="mark")expect(()=>mark(run.runId,"running",f.root)).toThrow(/ELOOP|symbolic link/i);
  else if(action==="prepare")await expect(prepare(run.runId,f.root,{cliEntry:f.cliEntry})).rejects.toThrow(/ELOOP|symbolic link/i);
  else await expect(dispose(run.runId,f.root)).rejects.toThrow(/ELOOP|symbolic link/i);
  expect(status(f.root).phase).toBe("acquired");expect(fs.existsSync(run.profile)).toBe(false);
  fs.unlinkSync(run.metadata);fs.renameSync(saved,run.metadata);await dispose(run.runId,f.root);
});
for (const action of ["mark", "prepare"]) it(`checks semantic metadata ownership before ${action}`, async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);mark(run.runId,"acquired",f.root);
  const bytes=fs.readFileSync(run.metadata,"utf8");fs.writeFileSync(run.metadata,JSON.stringify({...JSON.parse(bytes),owner:{hostId:"foreign"}}));
  if(action==="mark")expect(()=>mark(run.runId,"running",f.root)).toThrow(/metadata owner mismatch/);
  else await expect(prepare(run.runId,f.root,{cliEntry:f.cliEntry})).rejects.toThrow(/metadata owner mismatch/);
  expect(status(f.root).phase).toBe("acquired");expect(fs.existsSync(run.profile)).toBe(false);
  fs.writeFileSync(run.metadata,bytes);await dispose(run.runId,f.root);
});
it("accepts the distinct lease/metadata inodes produced by prepare and mark", async () => {
  const f=fixture();const run=await acquire(f.arg,f.root);const lease=path.join(f.root,"lease.json");
  expect(fs.statSync(lease).ino).toBe(fs.statSync(run.metadata).ino);
  await prepare(run.runId,f.root,{cliEntry:f.cliEntry});
  const leaseInode=fs.statSync(lease).ino,metadataInode=fs.statSync(run.metadata).ino;
  expect(leaseInode).not.toBe(metadataInode);
  mark(run.runId,"running",f.root);
  expect(fs.statSync(lease).ino).not.toBe(leaseInode);expect(fs.statSync(run.metadata).ino).not.toBe(metadataInode);
  expect(status(f.root).phase).toBe("running");await dispose(run.runId,f.root);expect(status(f.root)).toBeNull();
});
