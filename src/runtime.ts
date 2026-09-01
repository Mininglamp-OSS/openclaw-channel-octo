import type { PluginRuntime } from "openclaw/plugin-sdk/core";

// State lives on globalThis under a registered Symbol — NOT on a module-scope
// `let`. Reason: when OpenClaw SDK's loadBundledEntryExportSync loads this
// file via its loader (jiti fallback on older Node, or any path Node ESM
// require(esm) doesn't unify), it produces a DIFFERENT module record from
// the one ESM static `import` produces. Two records → two `let runtime`
// slots → setOctoRuntime writes to one, getOctoRuntime reads the other,
// "Octo runtime not initialized" at first inbound message.
//
// This bit OctoPush (Electron-bundled older Node) under
// OPENCLAW_NO_RESPAWN=1 + SIGUSR1 in-process restart — see issue #77.
// 1.0.4 also hit it on a different code path (CHANGELOG line 113).
//
// Symbol.for() returns the SAME symbol across module copies, so any loader
// instance reaches the same globalThis slot. Process-scoped singleton.
const RUNTIME_KEY = Symbol.for("openclaw.octo.runtime");

type GlobalWithRuntime = typeof globalThis & {
  [RUNTIME_KEY]?: PluginRuntime;
};

export function setOctoRuntime(next: PluginRuntime) {
  (globalThis as GlobalWithRuntime)[RUNTIME_KEY] = next;
}

export function getOctoRuntime(): PluginRuntime {
  const runtime = (globalThis as GlobalWithRuntime)[RUNTIME_KEY];
  if (!runtime) {
    throw new Error("Octo runtime not initialized");
  }
  return runtime;
}

// Test-only: clear the runtime slot. Tests that exercise registration must
// not leak state into sibling tests (vitest workers can share globalThis
// within a file). Not part of the plugin's public API.
export function _resetOctoRuntimeForTests() {
  delete (globalThis as GlobalWithRuntime)[RUNTIME_KEY];
}
