import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadHostConfigContract } from "../scripts/openclaw-e2e-state.mjs";
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
function poisonedCaller(){
  const dir=fs.mkdtempSync(path.join(tmpdir(),"octo-validator-caller-"));dirs.push(dir);
  const config=path.join(dir,"private-config.json");fs.writeFileSync(config,"CALLER_CONFIG_MUST_NOT_BE_READ");
  vi.stubEnv("OPENCLAW_STATE_DIR",dir);vi.stubEnv("OPENCLAW_CONFIG_PATH",config);
  return {dir,config};
}
it("isolates state, config and home before the first host import and during validate, then removes the child state",async()=>{
  const caller=poisonedCaller(),host=path.join(caller.dir,"fake-host");fs.mkdirSync(path.join(host,"dist"),{recursive:true});
  fs.writeFileSync(path.join(host,"package.json"),JSON.stringify({version:"synthetic",bin:{openclaw:"cli.mjs"}}));fs.writeFileSync(path.join(host,"cli.mjs"),"");
  fs.writeFileSync(path.join(host,"dist/validation-core-fixture.mjs"),`
    import fs from 'node:fs';
    const bootstrap=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
    const state=process.env.OPENCLAW_STATE_DIR,config=process.env.OPENCLAW_CONFIG_PATH,home=process.env.HOME;
    function validateConfigObject(value,options){return {ok:true,config:{value,bootstrap,state,config,home,env:options.env}};}
    export {validateConfigObject as a};
  `);
  const contract=await loadHostConfigContract(host);
  const observed=contract.validate({synthetic:true},{env:{HOME:caller.dir,OPENCLAW_STATE_DIR:caller.dir,OPENCLAW_CONFIG_PATH:caller.config}}).config;
  expect(observed.bootstrap).toEqual({});expect(observed.state).not.toBe(caller.dir);
  expect(observed.config).toBe(path.join(observed.state,"openclaw.json"));expect(observed.home).toBe(observed.state);
  expect(observed.env.OPENCLAW_STATE_DIR).toBe(observed.state);expect(observed.env.OPENCLAW_CONFIG_PATH).toBe(observed.config);
  expect(fs.existsSync(observed.state)).toBe(false);
  expect(process.env.OPENCLAW_STATE_DIR).toBe(caller.dir);expect(process.env.OPENCLAW_CONFIG_PATH).toBe(caller.config);
  expect(fs.readFileSync(caller.config,"utf8")).toBe("CALLER_CONFIG_MUST_NOT_BE_READ");
});
it("the actual installed validator succeeds with a poisoned caller config without loading caller state",async()=>{
  const caller=poisonedCaller();
  const host=fileURLToPath(new URL("../node_modules/openclaw",import.meta.url));
  const contract=await loadHostConfigContract(host);
  expect(contract.validate({agents:{defaults:{workspace:path.join(caller.dir,"synthetic-workspace")},entries:{main:{}}}}).ok).toBe(true);
  expect(fs.readFileSync(caller.config,"utf8")).toBe("CALLER_CONFIG_MUST_NOT_BE_READ");
});
