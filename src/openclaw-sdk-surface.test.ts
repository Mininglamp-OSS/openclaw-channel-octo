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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/** Every .ts file we ship or test, excluding build output and deps. */
function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(repoRoot, "src"));
  for (const entry of ["index.ts", "setup-entry.ts"]) out.push(join(repoRoot, entry));
  // This file names the forbidden APIs in order to look for them.
  const self = fileURLToPath(import.meta.url);
  return out.filter((f) => f !== self);
}

const sourceFiles = collectSourceFiles();
const rel = (f: string) => f.slice(repoRoot.length + 1);

describe("OpenClaw SDK surface", () => {
  it("imports openclaw only through subpaths the installed version actually exports", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "node_modules", "openclaw", "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const exported = new Set(Object.keys(pkg.exports ?? {}));
    expect(exported.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      // Skip comment lines: they legitimately name subpaths in prose.
      const text = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      for (const m of text.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+"(openclaw(?:\/[^"]*)?)"/gm)) {
        const spec = m[1];
        const subpath = spec === "openclaw" ? "." : "." + spec.slice("openclaw".length);
        if (!exported.has(subpath)) offenders.push(`${rel(file)} -> ${spec}`);
      }
    }

    expect(offenders, `unexported openclaw subpath(s):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("never calls the config APIs OpenClaw removed in 2026.8", () => {
    // current() has existed since 2026.6 and is the only supported reader.
    const removed = ["config.loadConfig(", "config.writeConfigFile("];
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(file, "utf8");
      for (const api of removed) {
        if (text.includes(api)) offenders.push(`${rel(file)} -> ${api})`);
      }
    }
    expect(offenders, `removed config API in use:\n${offenders.join("\n")}`).toEqual([]);
  });
});
