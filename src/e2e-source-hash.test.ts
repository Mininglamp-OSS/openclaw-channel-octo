import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { sourceHashArgs } from "../e2e/runtime-scope/source-hash.mjs";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir=fs.mkdtempSync(path.join(tmpdir(),"octo-source-hash-"));dirs.push(dir);
  const root=path.join(dir,"custom profile 'with quotes'");fs.mkdirSync(path.join(root,"original-workspace"),{recursive:true});
  fs.writeFileSync(path.join(root,"openclaw.json"),"{}");fs.writeFileSync(path.join(root,"original-workspace/sentinel"),"synthetic-only");
  return root;
}
function hash(root: string) {
  const [node,...args]=sourceHashArgs({OCTO_E2E_STATE_ROOT:root});
  expect(node).toBe("node");
  return execFileSync(process.execPath,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
}
it("selects the runner's default root only when the override is absent", () => {
  expect(sourceHashArgs({}).at(-1)).toBe("/root/.openclaw-dev");
  vi.stubEnv("OCTO_E2E_STATE_ROOT","/tmp/selected-source");
  expect(sourceHashArgs().at(-1)).toBe("/tmp/selected-source");
});
it("hashes both files at the custom root and detects their independent mutations", () => {
  const root=fixture(),initial=hash(root);expect(initial).toMatch(/^[0-9a-f]{64}$/);expect(hash(root)).toBe(initial);
  const decoy=fixture();fs.writeFileSync(path.join(decoy,"openclaw.json"),"unrelated");expect(hash(root)).toBe(initial);
  fs.writeFileSync(path.join(root,"openclaw.json"),'{"changed":true}');expect(hash(root)).not.toBe(initial);
  fs.writeFileSync(path.join(root,"openclaw.json"),"{}");expect(hash(root)).toBe(initial);
  fs.writeFileSync(path.join(root,"original-workspace/sentinel"),"changed sentinel");expect(hash(root)).not.toBe(initial);
});
for (const name of ["openclaw.json","original-workspace/sentinel"]) it(`fails rather than accepting a missing selected ${name}`, () => {
  const root=fixture();fixture();fs.unlinkSync(path.join(root,name));
  expect(()=>hash(root)).toThrow(/ENOENT/);
});
it("rejects a directory in place of the source sentinel", () => {
  const root=fixture(),sentinel=path.join(root,"original-workspace/sentinel");fs.unlinkSync(sentinel);fs.mkdirSync(sentinel);
  expect(()=>hash(root)).toThrow(/requires a regular file/);
});
it("does not reinterpret an empty override as the default root", () => {
  expect(sourceHashArgs({OCTO_E2E_STATE_ROOT:""}).at(-1)).toBe("");expect(()=>hash("")).toThrow(/absolute state root/);
});
