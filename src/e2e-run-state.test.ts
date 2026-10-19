import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { acquire, prepare, dispose, status } from "../scripts/openclaw-e2e-state.mjs";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "octo-run-state-")); dirs.push(dir);
  const sourceRoot = path.join(dir, "source"); fs.mkdirSync(sourceRoot);
  const source = { tools: { deny: ["dangerous-tool"] }, agents: { defaults: { workspace: "/must-not-write" } },
    plugins: { entries: { octo: { hooks: { allowConversationAccess: true } } } },
    channels: { octo: { accounts: { scope: { enabled: true, botToken: "synthetic", apiUrl: "http://fake.invalid" } } } } };
  const bytes = JSON.stringify(source); fs.writeFileSync(path.join(sourceRoot, "openclaw.json"), bytes);
  return { root: path.join(dir, "control"), sourceRoot, bytes,
    arg: { runId: randomUUID(), owner: { hostId: "test", pid: 1, birth: "test" }, sourceRoot, containerId: "fake-container" } };
}
it("exclusive acquisition precedes mutation and cannot overwrite another owner's backup", async () => {
  const f = fixture(); const run = await acquire(f.arg, f.root);
  await expect(acquire({ ...f.arg, runId: randomUUID() }, f.root)).rejects.toThrow(/leased/);
  expect(fs.readFileSync(run.snapshot, "utf8")).toBe(f.bytes);
  expect(fs.readFileSync(path.join(f.sourceRoot, "openclaw.json"), "utf8")).toBe(f.bytes);
  await dispose(run.runId, f.root);
});
it("simultaneous acquisitions cannot both win even before the outer flock", async () => {
  const f = fixture(); const results = await Promise.allSettled([acquire(f.arg, f.root), acquire({ ...f.arg, runId: randomUUID() }, f.root)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const lease = status(f.root); expect([f.arg.runId, ...results.flatMap((r) => r.status === "fulfilled" ? [r.value.runId] : [])]).toContain(lease.runId);
  await dispose(lease.runId, f.root);
});
it("private setup isolates configuration, sessions/workspace and preserves restrictions", async () => {
  const f = fixture(); const run = await acquire(f.arg, f.root); const prepared = prepare(run.runId, f.root);
  const cfg = JSON.parse(fs.readFileSync(path.join(prepared.profile, "openclaw.json"), "utf8"));
  expect(cfg.tools.deny).toEqual(["dangerous-tool"]);
  expect(cfg.agents.defaults.workspace).toBe(path.join(prepared.profile, "workspace"));
  expect(cfg.session.store).toBeUndefined();
  expect(fs.readFileSync(path.join(f.sourceRoot, "openclaw.json"), "utf8")).toBe(f.bytes);
  expect(() => prepare(run.runId, f.root)).toThrow(/not repeatable/);
  await dispose(run.runId, f.root);
  expect(fs.existsSync(prepared.profile)).toBe(false);
});
it("foreign/stale recovery tokens cannot remove another run; disposal works from durable state", async () => {
  const f = fixture(); const run = await acquire(f.arg, f.root); prepare(run.runId, f.root);
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
  const run = await acquire(f.arg, f.root); const prepared = prepare(run.runId, f.root);
  const cfg = JSON.parse(fs.readFileSync(path.join(prepared.profile, "openclaw.json"), "utf8"));
  const actual = layout === "entries" ? cfg.agents.entries.main : cfg.agents.list[0];
  expect(actual.tools).toEqual(main.tools); expect(actual.subagents).toEqual(main.subagents);
  expect(actual.workspace).toBe(path.join(prepared.profile, "workspace"));
  await dispose(run.runId, f.root);
});
