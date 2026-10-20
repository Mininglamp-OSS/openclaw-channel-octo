import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exercise the actual probe's catch/finally in a subprocess. The tiny host and
// plugin are fault doubles only; this does not claim managed-runtime coverage.
it("production-path account rejection still closes the real listener, disposes live instance and removes fixture",()=>{
  const root=fs.mkdtempSync(path.join(tmpdir(),"octo-probe-cleanup-"));
  const host=path.join(root,"host"),receipt=path.join(root,"cleanup.log");
  try {
    for(const dir of ["src","scripts","node_modules","dist/src","e2e/runtime-scope","host/dist"])fs.mkdirSync(path.join(root,dir),{recursive:true});
    fs.writeFileSync(path.join(root,"package.json"),'{"type":"module"}');fs.writeFileSync(path.join(root,"openclaw.plugin.json"),'{}');
    fs.writeFileSync(path.join(host,"package.json"),'{"version":"synthetic"}');
    fs.writeFileSync(path.join(host,"dist/plugin-setup-module-fault.mjs"),`
      import fs from 'node:fs';let n=0;
      export class PluginInstance{constructor(){this.n=++n;}bindModuleLoader(){}run(fn){return fn();}wrap(value){return value;}
        async dispose(){fs.appendFileSync(process.env.OCTO_CLEANUP_RECEIPT,'dispose:'+this.n+'\\n');}}
    `);
    fs.writeFileSync(path.join(root,"dist/index.js"),`export default{register(api){api.registerChannel({plugin:{gateway:{startAccount(){return Promise.reject(new Error('synthetic-account-rejected'));}}}});}};`);
    fs.writeFileSync(path.join(root,"dist/src/runtime.js"),"export function getOctoRuntime(){throw new Error('not called');}");
    for(const file of ["production-path.mjs","cleanup.mjs"])fs.copyFileSync(fileURLToPath(new URL("../e2e/runtime-scope/"+file,import.meta.url)),path.join(root,"e2e/runtime-scope",file));
    fs.copyFileSync(fileURLToPath(new URL("../scripts/openclaw-e2e-host-env.mjs",import.meta.url)),path.join(root,"scripts/openclaw-e2e-host-env.mjs"));
    fs.writeFileSync(path.join(root,"e2e/runtime-scope/synthetic-octo.mjs"),`
      import fs from 'node:fs';import {createServer} from 'node:http';export const REPLY='synthetic';
      export async function createSyntheticOcto(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
        return {baseUrl:'http://127.0.0.1:'+server.address().port,delivered:new Promise(()=>{}),failed:new Promise(()=>{}),
          async close(){await new Promise(r=>server.close(r));fs.appendFileSync(process.env.OCTO_CLEANUP_RECEIPT,'server-closed\\n');}};}
    `);
    const result=spawnSync(process.execPath,[path.join(root,"e2e/runtime-scope/production-path.mjs")],{
      env:{...process.env,OCTO_RUNTIME_HOST_ROOT:host,OCTO_CLEANUP_RECEIPT:receipt},encoding:"utf8",timeout:10000});
    expect(result.status).not.toBe(0);expect(result.stderr).toContain("synthetic-account-rejected");
    expect(fs.readFileSync(receipt,"utf8").split("\n").filter(Boolean)).toEqual(["dispose:2","server-closed","dispose:1"]);
    expect(fs.readdirSync(path.join(root,"src"))).toEqual([]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
