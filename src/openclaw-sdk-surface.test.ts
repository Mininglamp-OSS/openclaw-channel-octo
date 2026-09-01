/**
 * Guards this plugin against OpenClaw SDK surface drift.
 *
 * Two classes of breakage shipped silently before this test existed, both found
 * only after upgrading the peer dep:
 *
 * 1. `openclaw/plugin-sdk` (the bare aggregate subpath) was dropped in
 *    2026.8. Nine files imported types from it. Resolution then walked UP the
 *    directory tree into any stray `node_modules/openclaw` above the repo and
 *    silently type-checked against THAT copy; on a clean machine it is a hard
 *    module-not-found instead.
 * 2. `PluginRuntime.config.loadConfig()` was deprecated in 2026.6 and removed
 *    in 2026.8. The inbound path called it, so on 2026.8 every group message
 *    threw TypeError mid-pipeline and was dropped — the bot just went quiet.
 *
 * Both are cheap to assert statically and expensive to find by hand, so they
 * are checked here against the openclaw actually installed.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/**
 * Every source file we ship, test, or run in CI.
 *
 * Scope is the whole point: the first version of this guard walked only
 * `src/**` plus the two root entries, so `e2e/openclaw-host-plugin/index.mjs`
 * went on calling the removed `config.loadConfig()` while this test reported
 * green — a guard with a blind spot is worse than no guard, because it is
 * trusted. Walk the repo and match every executable extension rather than
 * enumerating locations, so a new directory or a .mjs is covered by default.
 */
function collectSourceFiles(): string[] {
  const out: string[] = [];
  const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      // lstat, not stat: a symlink pointing at a parent dir (or node_modules)
      // would otherwise make this walk recurse forever.
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (CODE.test(entry)) out.push(full);
    }
  };
  walk(repoRoot);
  // This file names the forbidden APIs in order to look for them.
  const self = fileURLToPath(import.meta.url);
  return out.filter((f) => f !== self);
}

const sourceFiles = collectSourceFiles();
const rel = (f: string) => f.slice(repoRoot.length + 1);

/**
 * File contents with whole-line comments removed.
 *
 * Both checks below need this: prose legitimately names an unexported subpath or
 * a removed API when explaining why the code avoids it, and flagging that is a
 * false positive that pushes people toward vaguer comments. Line-granular is
 * enough here — a real call sits on a code line.
 */
function readCode(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("OpenClaw SDK surface", () => {
  it("imports openclaw only through subpaths the installed version actually exports", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "node_modules", "openclaw", "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const exported = new Set(Object.keys(pkg.exports ?? {}));
    expect(exported.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = readCode(file);
      for (const m of text.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+"(openclaw(?:\/[^"]*)?)"/gm)) {
        const spec = m[1];
        const subpath = spec === "openclaw" ? "." : "." + spec.slice("openclaw".length);
        if (!exported.has(subpath)) offenders.push(`${rel(file)} -> ${spec}`);
      }
    }

    expect(offenders, `unexported openclaw subpath(s):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("actually covers the e2e host bridge and scripts, not just src/", () => {
    // Pins the blind spot that let a removed-API call ship green.
    const files = sourceFiles.map(rel);
    expect(files).toContain(join("e2e", "openclaw-host-plugin", "index.mjs"));
    expect(files.some((f) => f.startsWith("scripts" + sep))).toBe(true);
    expect(files).toContain("index.ts");
    expect(files).toContain("setup-entry.ts");
  });

  it("never calls the config APIs OpenClaw removed in 2026.8", () => {
    // current() has existed since 2026.6 and is the only supported reader.
    const removed = ["config.loadConfig(", "config.writeConfigFile("];
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = readCode(file);
      for (const api of removed) {
        if (text.includes(api)) offenders.push(`${rel(file)} -> ${api})`);
      }
    }
    expect(offenders, `removed config API in use:\n${offenders.join("\n")}`).toEqual([]);
  });
});
