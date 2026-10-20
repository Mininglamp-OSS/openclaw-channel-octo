import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, hostname, userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectOwner, ownerBirth, verifyRecoveryOwner } from "../scripts/openclaw-e2e-owner.mjs";
const birth="Mon Oct 19 20:00:00 2026";
const owner={pid:12345,birth};
const failure=(code:string)=>Object.assign(new Error("synthetic process lookup failure"),{code});

for(const mode of ["missing","error","empty","malformed"]) it(`refuses a live owner when ps is ${mode}`,async()=>{
  const query=vi.fn(async()=>{
    if(mode==="missing")throw failure("ENOENT");
    if(mode==="error")throw failure("EACCES");
    return {stdout:mode==="empty"?"":"not a birth stamp"};
  });
  const probe=(pid:number)=>inspectOwner(pid,{query,signal:()=>{}});
  expect(await probe(owner.pid)).toMatchObject({state:"unverifiable"});
  await expect(ownerBirth(owner.pid,probe)).rejects.toThrow(/initial runner birth/);
  await expect(verifyRecoveryOwner(owner,probe)).rejects.toThrow(/cannot verify lease owner/);
});
it("permission failure checking PID existence is not absence",async()=>{
  const query=vi.fn();const result=await inspectOwner(owner.pid,{query,signal:()=>{throw failure("EPERM");}});
  expect(result.state).toBe("unverifiable");expect(query).not.toHaveBeenCalled();
  await expect(verifyRecoveryOwner(owner,async()=>result)).rejects.toThrow(/cannot verify/);
});
it("only ESRCH confirms an absent PID without depending on ps",async()=>{
  const query=vi.fn();const result=await inspectOwner(owner.pid,{query,signal:()=>{throw failure("ESRCH");}});
  expect(result.state).toBe("absent");expect(query).not.toHaveBeenCalled();
  await expect(verifyRecoveryOwner(owner,async()=>result)).resolves.toBeUndefined();
  await expect(ownerBirth(owner.pid,async()=>result)).rejects.toThrow(/initial runner birth/);
});
it("a PID that exits during a failed ps query must be independently confirmed absent",async()=>{
  const signal=vi.fn().mockImplementationOnce(()=>{}).mockImplementationOnce(()=>{throw failure("ESRCH");});
  expect(await inspectOwner(owner.pid,{query:async()=>{throw failure("ENOENT");},signal})).toMatchObject({state:"absent"});
});
it("requires a nonempty validated stamp and distinguishes same versus different live identities",async()=>{
  const result=await inspectOwner(owner.pid,{query:async()=>({stdout:`  ${birth}\n`}),signal:()=>{}});
  expect(result).toEqual({state:"present",birth});
  await expect(ownerBirth(owner.pid,async()=>result)).resolves.toBe(birth);
  await expect(verifyRecoveryOwner(owner,async()=>result)).rejects.toThrow(/still alive/);
  await expect(verifyRecoveryOwner({...owner,birth:"Mon Oct 19 19:00:00 2026"},async()=>result)).rejects.toThrow(/different birth/);
});
for(const token of ["", " ", "not a birth stamp", undefined]) it(`retains leases with an invalid recorded birth (${String(token)})`,async()=>{
  const probe=vi.fn(async()=>({state:"absent"}));
  await expect(verifyRecoveryOwner({...owner,birth:token},probe)).rejects.toThrow(/no valid owner birth/);
  expect(probe).not.toHaveBeenCalled();
});
for(const pid of [0,-1,NaN]) it(`does not inspect an invalid PID ${pid}`,async()=>{
  const query=vi.fn(),signal=vi.fn();expect(await inspectOwner(pid,{query,signal})).toMatchObject({state:"unverifiable"});
  expect(query).not.toHaveBeenCalled();expect(signal).not.toHaveBeenCalled();
});
it("inspects this real live process and refuses to recover it",async()=>{
  const current=await inspectOwner(process.pid);expect(current.state).toBe("present");
  await expect(verifyRecoveryOwner({pid:process.pid,birth:current.birth})).rejects.toThrow(/still alive/);
});

// Actual runner subprocess + real owner PID. Only Docker is a file-backed stub;
// the injected ps executable fails/changes output through the subprocess PATH.
const fixtures:string[]=[];
afterEach(()=>{for(const dir of fixtures.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
for(const mode of ["missing","error","empty","malformed","live","different","legacy-empty","initial-empty"]) it(`actual runner retains active resources for ${mode} inspection`,async()=>{
  const root=fs.mkdtempSync(path.join(tmpdir(),"octo-owner-runner-"));fixtures.push(root);
  const bin=path.join(root,"bin");fs.mkdirSync(bin);fs.mkdirSync(path.join(root,"run-data"));
  fs.writeFileSync(path.join(root,"run-data/keep"),"active-owner-only");
  const actualBirth=await ownerBirth(process.pid);
  const runId="12345678-1234-1234-1234-123456789abc";
  const lease={runId,containerId:"fake-container",owner:{hostId:`${hostname()}:${userInfo().uid}`,pid:process.pid,
    birth:mode==="legacy-empty"?"":mode==="different"?birth:actualBirth}};
  fs.writeFileSync(path.join(root,"lease.json"),JSON.stringify(lease));
  fs.writeFileSync(path.join(bin,"docker"),`#!${process.execPath}
const fs=require('fs'),path=require('path'),root=process.env.OCTO_OWNER_TEST_ROOT,args=process.argv.slice(2);
const action=args[0]==='inspect'?'inspect':args.includes('flock')?JSON.parse(args.at(-1)).action:'mkdir';
fs.appendFileSync(path.join(root,'calls'),action+'\\n');
if(action==='inspect')console.log(JSON.stringify('fake-container'));
else if(action==='status')process.stdout.write(fs.readFileSync(path.join(root,'lease.json')));
else if(action==='dispose'){fs.rmSync(path.join(root,'run-data'),{recursive:true});console.log('{}');}
else if(action!=='mkdir')throw new Error('unexpected mutation '+action);
`,{mode:0o700});
  if(mode!=="missing"){
    const ps=path.join(bin,"ps");
    if(["live","different","legacy-empty"].includes(mode))fs.symlinkSync("/bin/ps",ps);
    else fs.writeFileSync(ps,`#!/bin/sh\n${mode==="error"?"exit 2":mode==="malformed"?"echo invalid-process-data":"exit 0"}\n`,{mode:0o700});
  }
  const runner=fileURLToPath(new URL("../scripts/run-openclaw-card-e2e.mjs",import.meta.url));
  const result=spawnSync(process.execPath,[runner,...(mode==="initial-empty"?[]:["--recover",runId])],{
    env:{...process.env,PATH:bin,OCTO_OWNER_TEST_ROOT:root,OCTO_E2E_CONTAINER:"synthetic-only",OCTO_E2E_TARGET_UID:"synthetic-only"},encoding:"utf8",timeout:15000});
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(mode==="initial-empty"?/initial runner birth/:mode==="legacy-empty"?/no valid owner birth/:mode==="different"?/different birth/:mode==="live"?/still alive/:/cannot verify lease owner/);
  expect(fs.readFileSync(path.join(root,"run-data/keep"),"utf8")).toBe("active-owner-only");
  expect(fs.readFileSync(path.join(root,"lease.json"),"utf8")).toBe(JSON.stringify(lease));
  const calls=fs.existsSync(path.join(root,"calls"))?fs.readFileSync(path.join(root,"calls"),"utf8"):"";
  expect(calls).not.toContain("dispose");expect(calls).not.toContain("acquire");
  if(mode==="initial-empty")expect(calls).toBe("");
  expect(()=>process.kill(process.pid,0)).not.toThrow();
});
