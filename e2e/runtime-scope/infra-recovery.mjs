// Destructive fault injection ONLY in a task-created, idle synthetic container.
// Uses the actual runner; never targets a host installation or existing Gateway.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sourceHashArgs } from './source-hash.mjs';
const container = process.env.OCTO_E2E_CONTAINER;
if (!container || !process.env.OCTO_E2E_TARGET_UID) throw new Error('explicit dedicated container and synthetic target required');
const runner = 'scripts/run-openclaw-card-e2e.mjs';
const env = { ...process.env, OCTO_E2E_CONTAINER: container };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 });
const state = () => JSON.parse(docker('exec', container, 'node', '-e', "const f=require('fs'),p='/var/lib/octo-host-e2e/lease.json';console.log(f.existsSync(p)?f.readFileSync(p,'utf8'):'null')"));
const sourceHash = () => docker('exec', container, ...sourceHashArgs(env)).trim();
// Fail before any runner launch if either selected source file is missing.
const initial = sourceHash();
const output = [];
const assert = (ok, message) => { if (!ok) throw new Error(message); output.push(message); };
async function waitFor(fn, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 250)); }
  throw new Error('timed out waiting for runner');
}
function launch(args = [], gate) {
  const child = spawn(process.execPath, [runner, ...args], { env: { ...env, ...(gate ? { OCTO_E2E_TEST_GATE: gate } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
  const exit = new Promise(resolve => child.on('exit', (code, signal) => { child.result = { code, signal, text }; resolve(child.result); }));
  return { child, exit };
}
async function refused(args, expected) {
  const result = await launch(args).exit;
  assert(result.code !== 0 && result.text.includes(expected), `refused: ${expected}`);
}
assert(state() === null, 'dedicated container initially idle');
let active;
try {
  active = launch([], 'prepared');
  let lease = await waitFor(() => { if (active.child.result) throw new Error(active.child.result.text); const s = state(); return s?.phase === 'test-gate-prepared' && s; });
  const firstId = lease.runId;
  const sentinel = `/var/lib/octo-host-e2e/runs/${firstId}/requests/owner-sentinel`;
  docker('exec', container, 'node', '-e', "require('fs').writeFileSync(process.argv[1],'owner-data')", sentinel);
  await refused([], `leased by ${firstId}`);
  await refused(['--recover', firstId], 'runner is still alive');
  await refused(['--recover', randomUUID()], 'does not match');
  assert(docker('exec', container, 'cat', sentinel) === 'owner-data', 'second runner leaves first request ledger intact');
  active.child.kill('SIGTERM');
  assert((await active.exit).code !== 0 && state() === null, 'SIGTERM cleans private profile and releases lease');
  assert(sourceHash() === initial, 'SIGTERM leaves source config and fixed fixture sentinel byte-identical');
  active = launch([], 'ready');
  lease = await waitFor(() => { if (active.child.result) throw new Error(active.child.result.text); const s = state(); return s?.phase === 'test-gate-ready' && s; });
  assert(lease.runId !== firstId, 'sequential runs use distinct profile/request/log namespaces');
  const secondId = lease.runId;
  const owned = () => Number(docker('exec', container, 'node', '-e', "const f=require('fs');console.log(f.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{return f.readFileSync('/proc/'+p+'/environ','utf8').split('\\0').includes('OCTO_E2E_RUN_ID='+process.argv[1])&&f.readFileSync('/proc/'+p+'/stat','utf8').split(') ')[1][0]!=='Z'}catch{return false}}).length)", secondId).trim());
  assert(owned() > 0, 'private real Gateway is running before SIGKILL');
  docker('exec', '-d', container, 'node', '-e', "require('fs').writeFileSync('/tmp/octo-unrelated.pid',String(process.pid));setInterval(()=>{},1000)");
  const unrelated = await waitFor(() => { try { return docker('exec', container, 'cat', '/tmp/octo-unrelated.pid').trim(); } catch {} });
  active.child.kill('SIGKILL'); await active.exit;
  assert(state()?.runId === secondId && owned() > 0, 'SIGKILL leaves durable lease and owned Gateway for explicit recovery');
  assert(sourceHash() === initial, 'SIGKILL leaves source config and fixed fixture sentinel byte-identical before recovery');
  await refused([], `leased by ${secondId}`);
  await refused(['--recover', randomUUID()], 'does not match');
  const recovery = await launch(['--recover', secondId]).exit;
  assert(recovery.code === 0 && state() === null && owned() === 0, 'exact dead-owner recovery removes only owned Gateway/profile and releases lease');
  assert(docker('exec', container, 'node', '-e', "process.kill(Number(process.argv[1]),0);console.log('alive')", unrelated).trim() === 'alive', 'recovery preserves unrelated process');
  docker('exec', container, 'kill', unrelated);
  assert(sourceHash() === initial, 'source config and fixed fixture sentinel remain byte-identical after recovery');
  console.log(JSON.stringify({ passed: true, checks: output, sourceCheck: {
    sha256: initial, stateRoot: env.OCTO_E2E_STATE_ROOT ?? '/root/.openclaw-dev',
    relativeFiles: ['openclaw.json', 'original-workspace/sentinel'], scope: 'two-files-only',
  }, firstId, secondId }, null, 2));
} finally {
  if (active && active.child.exitCode === null && active.child.signalCode === null) { active.child.kill('SIGTERM'); await active.exit; }
}
