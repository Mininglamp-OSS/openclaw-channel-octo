// Arguments, not interpolated source: custom roots may contain spaces/quotes.
// Execute inside the dedicated container, where the runner reads these files.
export function sourceHashArgs(env = process.env) {
  return ["node", "-e", `
    const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
    const root = process.argv[1];
    if (!path.isAbsolute(root)) throw new Error("source preservation probe requires an absolute state root");
    const hash = crypto.createHash("sha256");
    for (const name of ["openclaw.json", "original-workspace/sentinel"]) {
      const file = path.join(root, name);
      if (!fs.statSync(file).isFile()) throw new Error("source preservation probe requires a regular file: " + file);
      const bytes = fs.readFileSync(file);
      hash.update(String(bytes.length) + ":").update(bytes);
    }
    console.log(hash.digest("hex"));
  `, env.OCTO_E2E_STATE_ROOT ?? "/root/.openclaw-dev"];
}
