import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0;
const validBirth = (birth) => typeof birth === "string" &&
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(birth) && Number.isFinite(Date.parse(birth));

// Only ESRCH confirms absence. Missing/broken ps, EPERM, empty output and
// malformed output are inspection failures, never evidence of a dead owner.
export async function inspectOwner(pid, { query = exec, signal = process.kill.bind(process) } = {}) {
  if (!validPid(pid)) return { state: "unverifiable", reason: "invalid PID" };
  const presence = () => {
    try { signal(pid, 0); return "present"; }
    catch (error) { return error.code === "ESRCH" ? "absent" : "unverifiable"; }
  };
  const first = presence();
  if (first !== "present") return { state: first, reason: first === "unverifiable" ? "process existence query failed" : undefined };
  try {
    const { stdout } = await query("ps", ["-o", "lstart=", "-p", String(pid)],
      { timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
    const birth = typeof stdout === "string" ? stdout.trim() : "";
    const last = presence();
    if (last !== "present") return { state: last };
    return validBirth(birth) ? { state: "present", birth }
      : { state: "unverifiable", reason: "ps returned no valid birth stamp" };
  } catch (error) {
    if (presence() === "absent") return { state: "absent" };
    return { state: "unverifiable", reason: `ps failed (${error.code ?? "unknown"})` };
  }
}
export async function ownerBirth(pid, probe = inspectOwner) {
  const result = await probe(pid);
  if (result.state !== "present" || !validBirth(result.birth)) throw new Error("cannot verify initial runner birth; refusing acquisition");
  return result.birth;
}
export async function verifyRecoveryOwner(owner, probe = inspectOwner) {
  if (!validPid(owner?.pid) || !validBirth(owner?.birth)) throw new Error("lease has no valid owner birth/PID; manual inspection required");
  const result = await probe(owner.pid);
  if (result.state === "absent") return;
  if (result.state === "present" && result.birth === owner.birth) throw new Error("lease runner is still alive; refusing recovery");
  if (result.state === "present" && validBirth(result.birth)) throw new Error("owner PID has a different birth; lease retained for manual inspection");
  throw new Error("cannot verify lease owner; refusing recovery: " + (result.reason ?? "unknown process identity"));
}
