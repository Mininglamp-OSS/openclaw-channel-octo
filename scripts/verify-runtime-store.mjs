import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("openclaw/plugin-sdk/runtime-store");
const hostRoot = resolve(dirname(sdkEntry), "../..");
const { version } = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
const source = readFileSync(resolve("src/runtime.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
// Keep files below this checkout so bare SDK imports resolve to its host.
const temp = mkdtempSync(resolve("src/.tmp-runtime-"));
const modules = await Promise.all(["a", "b"].map(async (name) => {
  const file = join(temp, `runtime-${name}.mjs`);
  writeFileSync(file, compiled);
  return import(pathToFileURL(file).href);
}));
const [a, b] = modules;
after(() => {
  a._resetOctoRuntimeForTests();
  rmSync(temp, { recursive: true, force: true });
});
beforeEach(() => a._resetOctoRuntimeForTests());

test(`official host SDK ${version}: standalone requires initialization`, () => {
  assert.throws(() => a.getOctoRuntime(), /Octo runtime not initialized/);
});
test("standalone set/get and replacement preserve object identity", () => {
  const first = { name: "first" };
  const next = { name: "next" };
  a.setOctoRuntime(first);
  assert.equal(a.getOctoRuntime(), first);
  a.setOctoRuntime(next);
  assert.equal(a.getOctoRuntime(), next);
});
test("two actual production module copies share standalone state (#77)", () => {
  assert.notEqual(a.setOctoRuntime, b.setOctoRuntime);
  const runtime = { name: "standalone" };
  a.setOctoRuntime(runtime);
  assert.equal(b.getOctoRuntime(), runtime);
  const next = { name: "from-b" };
  b.setOctoRuntime(next);
  assert.equal(a.getOctoRuntime(), next);
});
test("standalone reset clears both production module copies", () => {
  a.setOctoRuntime({ name: "standalone" });
  b._resetOctoRuntimeForTests();
  assert.throws(() => a.getOctoRuntime(), /Octo runtime not initialized/);
  assert.throws(() => b.getOctoRuntime(), /Octo runtime not initialized/);
});

// Test-only access to the affected host's real invocation scope. Production
// code imports only the public runtime-store API. Older hosts predate this
// managed-instance contract; they still run all standalone/dual-copy checks.
const invocationFiles = readdirSync(join(hostRoot, "dist"))
  .filter((name) => /^plugin-instance-invocation-.*\.m?js$/.test(name));
const [year, month, day] = version.split(".").map(Number);
const managedHost = year > 2026 || (year === 2026 && (month > 10 || (month === 10 && day >= 5)));
if (managedHost) assert.ok(invocationFiles.length > 0, "managed host invocation chunk must exist");
let invocation;
for (const file of invocationFiles) {
  const exports = await import(pathToFileURL(join(hostRoot, "dist", file)).href);
  invocation = Object.values(exports).find((value) =>
    value && typeof value.run === "function" && typeof value.getStore === "function");
  if (invocation) break;
}
if (invocationFiles.length) assert.ok(invocation, "must locate the real host invocation scope");
const managed = invocation ? {} : { skip: `SDK ${version} has no managed invocation scope` };
const scope = () => ({ instance: { slots: new Map() } });

test("candidate B cannot replace live A's runtime (#271)", managed, () => {
  const live = scope();
  const candidate = scope();
  const runtimeA = { name: "live" };
  invocation.run(live, () => a.setOctoRuntime(runtimeA));
  invocation.run(candidate, () => b.setOctoRuntime({ name: "candidate" }));
  invocation.run(live, () => assert.equal(a.getOctoRuntime(), runtimeA));
});
test("module copies share a slot within the same managed instance", managed, () => {
  const live = scope();
  const runtime = { name: "live" };
  invocation.run(live, () => a.setOctoRuntime(runtime));
  invocation.run(live, () => assert.equal(b.getOctoRuntime(), runtime));
});
test("clearing B cannot clear A's runtime (#271)", managed, () => {
  const live = scope();
  const candidate = scope();
  const runtimeA = { name: "live" };
  invocation.run(live, () => a.setOctoRuntime(runtimeA));
  invocation.run(candidate, () => a.setOctoRuntime({ name: "candidate" }));
  invocation.run(candidate, () => b._resetOctoRuntimeForTests());
  invocation.run(live, () => assert.equal(b.getOctoRuntime(), runtimeA));
  invocation.run(candidate, () => assert.throws(() => a.getOctoRuntime(), /Octo runtime not initialized/));
});
test("an uninitialized managed instance never borrows standalone or A's runtime", managed, () => {
  a.setOctoRuntime({ name: "standalone" });
  invocation.run(scope(), () => a.setOctoRuntime({ name: "live" }));
  invocation.run(scope(), () => assert.throws(() => b.getOctoRuntime(), /Octo runtime not initialized/));
});
test("managed initialization and cleanup leave standalone state intact", managed, () => {
  const standalone = { name: "standalone" };
  a.setOctoRuntime(standalone);
  invocation.run(scope(), () => {
    a.setOctoRuntime({ name: "managed" });
    b._resetOctoRuntimeForTests();
    assert.throws(() => a.getOctoRuntime(), /Octo runtime not initialized/);
  });
  assert.equal(b.getOctoRuntime(), standalone);
});
test("standalone cleanup cannot clear a managed instance's runtime", managed, () => {
  const live = scope();
  const runtime = { name: "live" };
  invocation.run(live, () => a.setOctoRuntime(runtime));
  a.setOctoRuntime({ name: "standalone" });
  b._resetOctoRuntimeForTests();
  invocation.run(live, () => assert.equal(b.getOctoRuntime(), runtime));
});
test("interleaved async calls resolve their own managed instance across module copies", managed, async () => {
  const runtimeA = { name: "live" };
  const runtimeB = { name: "candidate" };
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const liveWork = invocation.run(scope(), async () => {
    a.setOctoRuntime(runtimeA);
    await ready;
    assert.equal(b.getOctoRuntime(), runtimeA);
  });
  await invocation.run(scope(), async () => {
    b.setOctoRuntime(runtimeB);
    await Promise.resolve();
    assert.equal(a.getOctoRuntime(), runtimeB);
    a._resetOctoRuntimeForTests();
    release();
  });
  await liveWork;
});
