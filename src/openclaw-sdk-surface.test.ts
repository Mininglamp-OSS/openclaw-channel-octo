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
import { readdirSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { spawnSync } from "node:child_process";
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

  it("only imports openclaw subpaths that ship types, unless a local shim covers them", () => {
    // A subpath can be present in `exports` yet carry only `default` and no
    // `types` — tsc then fails with TS7016 on a clean checkout. It does NOT fail
    // locally when a stray node_modules/openclaw sits above the repo, because
    // resolution walks up and finds that copy's .d.ts. That asymmetry is exactly
    // how thread-bindings-runtime shipped a build-breaking import: green locally,
    // red in CI. Checking export shape here catches it without needing a clean
    // machine.
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "node_modules", "openclaw", "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };

    // Subpaths we knowingly import without host types, each covered by a local
    // ambient declaration. Empty by design: prefer a subpath that ships types.
    //
    // Every entry MUST be justified by a real, GIT-TRACKED declaration file —
    // asserted below, not taken on faith. An earlier version of this guard listed
    // a subpath here on the strength of a shim that `.gitignore` (`*.d.ts`) had
    // silently kept out of the commit, so the guard passed green while a clean
    // checkout could not type-check at all. A whitelist that trusts its own
    // premise reproduces the blind spot this file exists to prevent.
    const shimmed = new Map<string, string>([
      // "./plugin-sdk/example": "src/openclaw-example.d.ts",
    ]);

    for (const [sub, shimPath] of shimmed) {
      const abs = join(repoRoot, shimPath);
      expect(
        existsSync(abs),
        `shim promised for ${sub} is missing from the working tree: ${shimPath}`,
      ).toBe(true);
      // Present on disk is not enough — CI only ever sees tracked files.
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", shimPath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(
        tracked.status,
        `shim for ${sub} exists but is NOT tracked by git (${shimPath}) — ` +
          "a clean checkout would not have it; check .gitignore",
      ).toBe(0);
    }

    const imported = new Set<string>();
    for (const file of sourceFiles) {
      for (const m of readCode(file).matchAll(
        /^\s*(?:import|export)[\s\S]*?from\s+"(openclaw(?:\/[^"]*)?)"/gm,
      )) {
        const spec = m[1];
        imported.add(spec === "openclaw" ? "." : "." + spec.slice("openclaw".length));
      }
    }

    const untyped: string[] = [];
    for (const sub of imported) {
      const entry = pkg.exports?.[sub];
      const hasTypes = !!entry && typeof entry === "object" && !!(entry as { types?: string }).types;
      if (!hasTypes && !shimmed.has(sub)) untyped.push(sub);
    }

    expect(
      untyped,
      `openclaw subpath(s) imported without types and without a local shim:\n${untyped.join("\n")}`,
    ).toEqual([]);
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
