// Host-side supervisor for a runner-owned build/test process group. A runner
// SIGKILL cannot run its own handler; this separate process observes reparenting.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
const [owner, file, ...args] = process.argv.slice(2);
const ownerPid = Number(owner);
if (!ownerPid || process.ppid !== ownerPid || !file) throw new Error('live direct runner parent required');
const child = spawn(file, args, { env: process.env, stdio: 'inherit', detached: true });
let stopping = false;
let force;
function stop(reason) {
  if (stopping) return;
  stopping = true;
  console.error(`[openclaw-e2e child] ${reason}; stopping group=${child.pid}`);
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
const watch = setInterval(() => { if (process.ppid !== ownerPid) stop('runner parent exited'); }, 100);
child.on('spawn', () => console.log(`[openclaw-e2e child] group=${child.pid}`));
child.once('error', error => { console.error(error.message); clearInterval(watch); clearTimeout(force); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  clearInterval(watch);
  // A worker can exit before its group. Clean remaining descendants without
  // replacing its original exit status with the cleanup signal's status.
  process.exitCode = code ?? (128 + (constants.signals[signal] ?? 1));
  if (!stopping) {
    try { process.kill(-child.pid, 0); stop('worker exited with remaining group'); }
    catch (error) { if (error.code !== 'ESRCH') { console.error(error.message); stop('group status unknown'); } }
  }
});
