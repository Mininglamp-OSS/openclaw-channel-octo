import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { it } from "vitest";

// Native Node keeps the official SDK's private invocation scope and its runtime
// store in the same loader. The probe transpiles actual runtime.ts, rather than
// testing a handwritten copy of its implementation (issues #77 and #271).
it("preserves the runtime store contract against the installed host SDK", () => {
  try {
    execFileSync(process.execPath, [
      "--test", resolve("scripts/verify-runtime-store.mjs"),
    ], { encoding: "utf8", timeout: 30_000, stdio: "pipe" });
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    throw new Error(`Native runtime contract failed:\n${output.stdout ?? ""}${output.stderr ?? ""}`, { cause: error });
  }
});
