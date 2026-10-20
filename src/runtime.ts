import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

// A named SDK store shares state across loader/module copies (#77), while
// instance-aware hosts resolve each call against its managed plugin instance
// (#271). Older supported hosts keep their named process-wide slot. Do not use
// the string overload: it creates a separate store for each module copy.
const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "octo",
  errorMessage: "Octo runtime not initialized",
});

export function setOctoRuntime(next: PluginRuntime) {
  store.setRuntime(next);
}

export function getOctoRuntime(): PluginRuntime {
  return store.getRuntime();
}

// Test-only: clear the current instance's slot (or the standalone slot when
// called outside managed invocation scope). Not part of the public plugin API.
export function _resetOctoRuntimeForTests() {
  store.clearRuntime();
}
