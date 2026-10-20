// Offline contract regression against the exact installed host used by the E2E
// runner. Only synthetic configs and temporary state; no Gateway/model request.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { acquire, prepare, dispose, loadHostConfigContract } from './openclaw-e2e-state.mjs';
import { isolateHostProcess } from './openclaw-e2e-host-env.mjs';
const require = createRequire(import.meta.url);
const hostRoot = fs.realpathSync(process.env.OCTO_E2E_POLICY_HOST_ROOT ?? path.resolve(path.dirname(require.resolve('openclaw/plugin-sdk/runtime-store')), '../..'));
const temp = isolateHostProcess('octo-host-policy-');
after(() => {
  fs.rmSync(temp, {recursive:true, force:true});
});
const contract = await loadHostConfigContract(hostRoot);
console.log(`Actual host schema/policy: OpenClaw ${contract.version} source=${contract.sourceCommit ?? "unavailable"}; ${process.version}`);
const files = fs.readdirSync(path.join(hostRoot, 'dist')).filter(f => /\.m?js$/.test(f));
const cache = new Map();
async function hostExport(name, prefix) {
  const candidates = files.filter(f => f.startsWith(prefix)).flatMap(file => {
    const source = fs.readFileSync(path.join(hostRoot, 'dist', file), 'utf8');
    const alias = source.match(new RegExp(`\\b${name} as (\\w+)`))?.[1];
    return alias && source.includes(`function ${name}(`) ? [{file, alias}] : [];
  });
  assert.equal(candidates.length, 1, `one actual host implementation/export required: ${name}`);
  const {file, alias} = candidates[0];
  const module = cache.get(file) ?? await import(pathToFileURL(path.join(hostRoot, 'dist', file)).href);
  cache.set(file, module); assert.equal(typeof module[alias], 'function'); return module[alias];
}
const effective = await hostExport('resolveEffectiveToolPolicy', 'agent-tools.policy-');
const profile = await hostExport('resolveCoreToolProfilePolicy', 'tool-catalog-');
const mergeAlso = await hostExport('mergeAlsoAllowPolicy', 'tool-policy-');
const pipeline = await hostExport('applyToolPolicyPipeline', 'tool-policy-pipeline-');
const steps = await hostExport('buildDefaultToolPolicyPipelineSteps', 'tool-policy-pipeline-');
const sender = await hostExport('resolveSenderToolPolicy', 'sender-tool-policy-');
const fsBoundary = await hostExport('resolveEffectiveToolFsWorkspaceOnly', 'tool-fs-policy-');
const execDefaults = await hostExport('resolveExecDefaults', 'exec-defaults-');
const execToolConfig = await hostExport('resolveExecToolConfig', contract.version === '2026.10.5' ? 'lazy-exec-tool-' : 'core-coding-tools-');
const corePolicy = contract.version === '2026.10.5' ? await hostExport('prepareCoreToolPolicy', 'prepared-tool-surface-') : undefined;
// Test-only access to the real host's private elevated gate. Add only an export
// in a temporary sibling module so its unmodified function/imports run normally.
// Original SDK bytes are never changed; the runner does not depend on this shim.
const replyFiles = files.filter(f => f.startsWith('get-reply-')).filter(file => fs.readFileSync(path.join(hostRoot, 'dist', file), 'utf8').includes('function resolveElevatedPermissions('));
assert.equal(replyFiles.length, 1);
const elevatedProbe = path.join(hostRoot, 'dist', `.octo-policy-${randomUUID()}.mjs`);
const replySource = fs.readFileSync(path.join(hostRoot, 'dist', replyFiles[0]), 'utf8');
fs.writeFileSync(elevatedProbe, replySource + '\nexport { resolveElevatedPermissions as octoTestElevated };\n');
let elevated;
try { elevated = (await import(pathToFileURL(elevatedProbe).href)).octoTestElevated; }
finally { fs.rmSync(elevatedProbe, {force:true}); }
const names = ['read','write','edit','apply_patch','exec','process','message','sessions_spawn','sessions_yield','web_search','octo_send_display_card'];
function parse(config) { const r = contract.validate(config); assert.equal(r.ok, true, JSON.stringify(r.issues)); return r.config; }
function project(config, provider = 'octo-e2e', model = 'scripted') {
  const policy = effective({config, agentId:'main', modelProvider:provider, modelId:model});
  return pipeline({tools:names.map(name => ({name})), toolMeta:t => t.name.startsWith('octo_') ? {pluginId:'octo'} : undefined,
    warn:()=>{}, steps:[...steps({...policy, profilePolicy:mergeAlso(profile(policy.profile), policy.profileAlsoAllow),
      providerProfilePolicy:mergeAlso(profile(policy.providerProfile), policy.providerProfileAlsoAllow)}),
      {label:'sender', policy:sender({config, agentId:'main', sessionKey:'agent:main:octo:scope:direct:synthetic-user', senderId:'synthetic-user', messageProvider:'octo'})}]}).map(t => t.name).sort();
}
function gates(config) {
  return {tools:project(config), workspaceOnly:fsBoundary({cfg:config, agentId:'main'}),
    exec:execDefaults({cfg:config, agentId:'main', sandboxAvailable:false,
      execApprovals:{version:1, defaults:{security:'full',ask:'off'}, agents:{}}}),
    elevated:elevated({cfg:config, agentId:'main', provider:'octo', ctx:{SenderId:'synthetic-user',From:'synthetic-user',AccountId:'scope'}})};
}
async function fixture(change = () => {}) {
  const dir = fs.mkdtempSync(path.join(temp, 'case-')), sourceRoot = path.join(dir, 'source');
  fs.mkdirSync(path.join(sourceRoot, 'extensions/octo/node_modules'), {recursive:true});
  fs.symlinkSync(hostRoot, path.join(sourceRoot, 'extensions/octo/node_modules/openclaw'));
  const config = {agents:{defaults:{workspace:path.join(sourceRoot,'workspace')},entries:{main:{}}},
    tools:{exec:{host:'gateway'}}, plugins:{allow:['octo'],entries:{octo:{hooks:{allowConversationAccess:true}}}},
    channels:{octo:{accounts:{scope:{enabled:true,botToken:'synthetic-only',apiUrl:'http://127.0.0.1:19124'}}}}};
  change(config);
  const bytes = JSON.stringify(config); fs.writeFileSync(path.join(sourceRoot,'openclaw.json'), bytes);
  const root = path.join(dir,'control');
  const run = await acquire({runId:randomUUID(),sourceRoot,owner:{hostId:'test',pid:process.pid,birth:'test'},containerId:'synthetic'}, root);
  return {config, bytes, sourceRoot, root, run, options:{cliEntry:contract.cliEntry}};
}
async function checkCase(change, assertion) {
  const f = await fixture(change);
  try {
    parse(f.config);
    await prepare(f.run.runId, f.root, f.options);
    const raw = JSON.parse(fs.readFileSync(path.join(f.run.profile,'openclaw.json'),'utf8'));
    const source = parse(f.config), privateConfig = parse(raw);
    assert.deepEqual(gates(privateConfig), gates(source), 'actual native policy/gates must not widen');
    assert.equal(raw.agents.defaults.elevatedDefault, f.config.agents.defaults.elevatedDefault);
    assert.deepEqual(raw.agents.defaults.skills, f.config.agents.defaults.skills);
    assert.deepEqual(raw.agents.defaults.sandbox, f.config.agents.defaults.sandbox);
    await assertion?.({source, privateConfig, raw, run:f.run});
  } finally {
    assert.equal(fs.readFileSync(path.join(f.sourceRoot,'openclaw.json'),'utf8'), f.bytes);
    await dispose(f.run.runId, f.root);
  }
}
async function rejectCase(change, pattern, setup) {
  const f = await fixture(change);
  try {
    setup?.(f);
    if (!pattern.source.includes('source config rejected')) parse(f.config);
    await assert.rejects(prepare(f.run.runId, f.root, f.options), pattern);
    assert.equal(fs.existsSync(path.join(f.run.profile,'openclaw.json')), false, 'refusal precedes runnable profile creation');
  } finally {
    assert.equal(fs.readFileSync(path.join(f.sourceRoot,'openclaw.json'),'utf8'), f.bytes);
    await dispose(f.run.runId, f.root);
  }
}
test('top-level deny, filesystem boundary, elevated disable and exec deny stay effective', () => checkCase(c => {
  c.tools = {deny:['exec','message','group:fs'],fs:{workspaceOnly:true},elevated:{enabled:false},exec:{host:'gateway',mode:'deny'}};
}, ({privateConfig}) => { assert.equal(project(privateConfig).includes('exec'),false); assert.equal(gates(privateConfig).exec.security,'deny'); assert.equal(gates(privateConfig).workspaceOnly,true); assert.equal(gates(privateConfig).elevated.allowed,false); }));
test('main deny and elevated disable narrow global grants using real host merge', () => checkCase(c => {
  c.tools.allow = ['*']; c.tools.elevated = {enabled:true,allowFrom:{octo:['*']}};
  c.agents.entries.main.tools = {deny:['exec','message'],elevated:{enabled:false},fs:{workspaceOnly:true}};
}, ({privateConfig}) => { assert.equal(project(privateConfig).includes('exec'),false); assert.equal(gates(privateConfig).elevated.allowed,false); }));
test('main allow intersects global allow rather than granting the union', () => checkCase(c => {
  c.tools.allow = ['read','exec']; c.agents.entries.main.tools = {allow:['read']};
}, ({privateConfig}) => assert.deepEqual(project(privateConfig), ['read'])));
test('main alsoAllow cannot override a restrictive top-level allow', () => checkCase(c => {
  c.tools.allow = ['read']; c.agents.entries.main.tools = {alsoAllow:['exec']};
}, ({privateConfig}) => assert.deepEqual(project(privateConfig), ['read'])));
test('global profile plus alsoAllow respects deny precedence', () => checkCase(c => {
  c.tools.profile = 'minimal'; c.tools.alsoAllow = ['read','exec']; c.tools.deny = ['exec'];
}, ({privateConfig}) => { assert.equal(project(privateConfig).includes('read'),true); assert.equal(project(privateConfig).includes('exec'),false); assert.equal(project(privateConfig).includes('write'),false); }));
test('main profile plus alsoAllow respects global deny and main deny', () => checkCase(c => {
  c.tools.deny = ['write']; c.agents.entries.main.tools = {profile:'minimal',alsoAllow:['read','write','exec'],deny:['exec']};
}, ({privateConfig}) => { assert.equal(project(privateConfig).includes('read'),true); assert.equal(project(privateConfig).includes('write'),false); assert.equal(project(privateConfig).includes('exec'),false); }));
test('supported defaults elevatedDefault off, sandbox off, skills and delegation limits survive', () => checkCase(c => {
  Object.assign(c.agents.defaults,{elevatedDefault:'off',sandbox:{mode:'off',workspaceAccess:'ro'},skills:[],subagents:{allowAgents:[],maxSpawnDepth:1}});
  c.tools.elevated = {enabled:true,allowFrom:{octo:['*']}};
}, ({raw,privateConfig}) => {assert.equal(raw.agents.defaults.elevatedDefault,'off');assert.equal(gates(privateConfig).elevated.allowed,true);assert.deepEqual(raw.agents.defaults.subagents,{allowAgents:[],maxSpawnDepth:1});}));
test('agent elevated sender allowlist can only narrow the global allowlist', () => checkCase(c => {
  c.tools.elevated = {enabled:true,allowFrom:{octo:['*']}};
  c.agents.entries.main.tools = {elevated:{enabled:true,allowFrom:{octo:[]}}};
}, ({privateConfig}) => assert.equal(gates(privateConfig).elevated.allowed,false)));
test('main exec deny and inline-eval/approval restrictions retain native resolution', () => checkCase(c => {
  c.tools.exec = {host:'gateway',mode:'allowlist',strictInlineEval:true,safeBins:[],applyPatch:{enabled:false,workspaceOnly:true,}};
  c.agents.entries.main.tools = {exec:{mode:'deny',strictInlineEval:true}};
}, ({raw,privateConfig}) => {assert.equal(gates(privateConfig).exec.security,'deny');assert.equal(raw.tools.exec.strictInlineEval,true);assert.deepEqual(raw.tools.exec.safeBins,[]);assert.equal(raw.tools.exec.applyPatch.enabled,false);
  const resolved=execToolConfig({cfg:privateConfig,agentId:'main'});assert.equal(resolved.strictInlineEval,true);assert.deepEqual(resolved.safeBins,[]);assert.equal(resolved.applyPatch.enabled,false);assert.equal(resolved.applyPatch.workspaceOnly,true);
  if(corePolicy){const policy=corePolicy({config:privateConfig,agentId:'main',modelProvider:'octo-e2e',modelId:'scripted'});assert.equal(policy.applyPatchEnabled,false);assert.equal(policy.applyPatchWorkspaceOnly,true);}}));
test('main filesystem override follows actual host precedence without flattening layers', () => checkCase(c => {
  c.tools.fs = {workspaceOnly:true}; c.agents.entries.main.tools = {fs:{workspaceOnly:false}};
}, ({privateConfig}) => assert.equal(gates(privateConfig).workspaceOnly,false)));
test('sender-specific denial is preserved through native sender policy parsing', () => checkCase(c => {
  c.tools.toolsBySender = {'id:synthetic-user':{deny:['exec','message']}};
}, ({privateConfig}) => assert.equal(project(privateConfig).includes('exec'),false)));
for (const policy of [{deny:['exec']},{allow:['read']},{alsoAllow:['read']},{elevated:{enabled:false},fs:{workspaceOnly:true}}]) {
  test(`unsupported agents.defaults.tools is rejected by actual ${contract.version} schema: ${JSON.stringify(policy)}`, () => rejectCase(c => {c.agents.defaults.tools=policy;}, /source config rejected.*schema.*tools/));
}
for (const scope of ['global','main']) test(`${scope} allow plus alsoAllow conflict is refused by real schema`, () => rejectCase(c => {
  const tools = scope === 'global' ? c.tools : (c.agents.entries.main.tools={}); tools.allow=['read'];tools.alsoAllow=['exec'];
}, /source config rejected.*schema/));
for (const scope of ['global','main']) test(`${scope} provider-specific deny is refused when switching synthetic provider`, () => rejectCase(c => {
  const tools = scope === 'global' ? c.tools : (c.agents.entries.main.tools={}); tools.byProvider={'restricted/model':{deny:['exec']}};
}, /byProvider cannot be preserved/));
for (const scope of ['global','main']) test(`${scope} model-scoped patch policy is refused when replacing the model`, () => rejectCase(c => {
  (scope === 'global' ? c.tools : (c.agents.entries.main.tools={})).exec={applyPatch:{workspaceOnly:true,allowModels:['restricted/model']}};
}, /allowModels cannot be preserved/));
test('an additional source agent is refused instead of discarding its tool policy', () => rejectCase(c => {c.agents.ownership='explicit';c.agents.entries.other={tools:{deny:['exec']}};}, /exactly one configured main agent/));
test('unmapped supported default model policy fails closed', () => rejectCase(c => {c.agents.defaults.modelPolicy={allow:['restricted/model']};}, /modelPolicy cannot be preserved/));
for (const scope of ['defaults','main']) test(`${scope} active sandbox is refused instead of changing execution context`, () => rejectCase(c => {
  (scope === 'defaults' ? c.agents.defaults : c.agents.entries.main).sandbox={mode:'all',workspaceAccess:'ro'};
}, /Gateway-local tools/));
for (const scope of ['global','main']) test(`${scope} remote exec context is refused`, () => rejectCase(c => {
  (scope === 'global' ? c.tools : (c.agents.entries.main.tools={})).exec={host:'node',mode:'deny'};
}, /different execution context/));
for (const file of ['exec-approvals.json','state/openclaw.sqlite']) test(`persisted ${file} is refused without reading/copying its contents`, () => rejectCase(()=>{}, /persisted policy/, f => {
  const p=path.join(f.sourceRoot,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'synthetic-policy-sentinel');
}));
test('a different CLI installation is refused even if its version could match', async () => {
  const f=await fixture();const wrong=path.join(temp,'different-cli');fs.writeFileSync(wrong,'synthetic');
  try {await assert.rejects(prepare(f.run.runId,f.root,{cliEntry:wrong}),/same exact host installation/);}
  finally {await dispose(f.run.runId,f.root);}
});

test('unmapped session send policy fails closed instead of being dropped', () => rejectCase(c => {
  c.session={sendPolicy:{default:'deny'}};
}, /source.session cannot be preserved/));
test('main skills and strict execution contract survive the private projection', () => checkCase(c => {
  c.agents.entries.main.skills=[];c.agents.entries.main.embeddedAgent={executionContract:'strict-agentic'};
}, ({raw}) => {assert.deepEqual(raw.agents.entries.main.skills,[]);assert.deepEqual(raw.agents.entries.main.embeddedAgent,{executionContract:'strict-agentic'});}));
test('source disabling Octo admission is refused rather than force-enabled', () => rejectCase(c => {
  c.plugins.allow=[];
}, /plugin admission cannot be preserved/));
test('an unavailable installed-host validator fails closed', async () => {
  const f=await fixture();const fake=path.join(temp,'unverifiable-host');fs.mkdirSync(path.join(fake,'dist'),{recursive:true});
  fs.writeFileSync(path.join(fake,'package.json'),JSON.stringify({version:'2026.10.5',bin:{openclaw:'openclaw.mjs'}}));
  fs.writeFileSync(path.join(fake,'openclaw.mjs'),'synthetic');const link=path.join(f.sourceRoot,'extensions/octo/node_modules/openclaw');
  fs.unlinkSync(link);fs.symlinkSync(fake,link);
  try {await assert.rejects(prepare(f.run.runId,f.root,{cliEntry:path.join(fake,'openclaw.mjs')}),/cannot verify installed OpenClaw/);assert.equal(fs.existsSync(path.join(f.run.profile,'openclaw.json')),false);}
  finally {await dispose(f.run.runId,f.root);}
});
test('an explicit denial of the test companion is respected', () => rejectCase(c => {
  c.plugins.deny=['octo-host-e2e'];
}, /plugin admission cannot be preserved/));
