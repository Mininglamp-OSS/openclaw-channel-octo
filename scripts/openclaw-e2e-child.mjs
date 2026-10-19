// Host-side supervisor for a runner-owned build/test process group. A runner
// SIGKILL cannot run its own handler; this separate process observes reparenting.
import { spawn } from 'node:child_process';
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
child.once('exit', code => {
  clearInterval(watch);
  // Do not cancel the group kill on leader exit: grandchildren may remain.
  if (!stopping) clearTimeout(force);
  process.exitCode = stopping ? 143 : code ?? 1;
});
