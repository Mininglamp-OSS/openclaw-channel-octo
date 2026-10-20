// Standalone probe processes only. Install before any host import and retain
// private paths until exit, so late SDK callbacks cannot return to caller state.
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
export function isolateHostProcess(prefix = "octo-host-probe-") {
  const root = fs.mkdtempSync(path.join(tmpdir(), prefix));
  const state = path.join(root, "state"), config = path.join(root, "openclaw.json");
  fs.mkdirSync(state); fs.writeFileSync(config, "{}", { mode: 0o600 });
  Object.assign(process.env, { HOME: root, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: config });
  process.once("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
