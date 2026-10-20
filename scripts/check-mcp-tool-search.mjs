/** Native Tool Search regression: synthetic tools/config, no Gateway or business calls. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerOctoMcpToolPolicy } from '../dist/src/mcp-connection.js';
process.env.OPENCLAW_CONFIG_PATH = '/dev/null';
process.env.OPENCLAW_STATE_DIR = '/tmp/octo-mcp-tool-search-fixture-' + process.pid;
const root = resolve(process.argv[2] ?? 'node_modules/openclaw');
async function hostExport(prefix, wanted) {
  for (const file of await readdir(join(root, 'dist'))) {
    if (!file.startsWith(prefix) || !file.endsWith('.mjs')) continue;
    const source = await readFile(join(root, 'dist', file), 'utf8');
    const exports = /export \{([^}]+)\};?\s*$/.exec(source)?.[1].split(',') ?? [];
    for (const spec of exports) {
      const [local, name = local] = spec.trim().split(/\s+as\s+/);
      if (local !== wanted && name !== wanted) continue;
      const loaded = await import(pathToFileURL(join(root, 'dist', file)).href);
      if (typeof loaded[name] === 'function') return loaded[name];
    }
  }
  throw new Error('Missing host export: ' + wanted);
}
const initialize = await hostExport('hook-runner-global-', 'initializeGlobalHookRunner');
const runner = await hostExport('hook-runner-global-', 'getGlobalHookRunner');
const reset = await hostExport('hook-runner-global-', 'resetGlobalHookRunner');
const register = await hostExport('tool-search-', 'registerHeadlessToolSearchCatalog');
const controls = await hostExport('tool-search-', 'createToolSearchTools');
const clear = await hostExport('tool-search-', 'clearToolSearchCatalog');
const config = { mcp: { servers: { 'octo-mcp': { transport: 'streamable-http', url: 'https://unused.example.test/' } } } };
const registry = { plugins: [], hooks: [], typedHooks: [], trustedToolPolicies: [] };
registerOctoMcpToolPolicy({ runtime: { config: { current: () => config } }, registerMcpServerConnectionResolver() {},
  on(hookName, handler, options) { registry.typedHooks.push({ pluginId: 'octo', hookName, handler, ...options }); } });
initialize(registry);
try {
  for (const scope of ['doctask:doc:comment', 'octo:bot-task:bot:loop:issue', 'dm:human']) {
    const external = scope !== 'dm:human';
    const catalogRef = {};
    const ctx = { config: {}, catalogRef, agentId: 'main', sessionKey: 'agent:main:octo:fixture:' + scope, runId: 'fixture-run' };
    const calls = [];
    const tools = ['octo-mcp__execute', 'mcp__octo-mcp__execute', 'fixture_lookup'].map(name => ({
      name, label: name, description: 'Synthetic lookup fixture', parameters: { type: 'object', properties: {} },
      async execute() { calls.push(name); return { content: [{ type: 'text', text: 'fixture-result' }] }; },
    }));
    register({ catalogRef, tools, hookContext: ctx });
    const available = controls(ctx);
    async function invoke(name, params) {
      const veto = await runner().runBeforeToolCall({ toolName: name, params }, { ...ctx, toolName: name });
      assert.equal(veto?.block, undefined, 'generic control must remain available');
      return available.find(tool => tool.name === name).execute('fixture-' + name, params);
    }
    try {
      await invoke('tool_search', { query: 'fixture_lookup' });
      await invoke('tool_describe', { id: 'fixture_lookup' });
      await invoke('tool_call', { id: 'fixture_lookup', args: {} });
      assert.deepEqual(calls, ['fixture_lookup']);
      for (const name of ['octo-mcp__execute', 'mcp__octo-mcp__execute']) {
        let blocked = false;
        try {
          const result = await invoke('tool_call', { id: name, args: {} });
          if (!calls.includes(name)) { assert.match(JSON.stringify(result), /Octo business MCP/); blocked = true; }
        }
        catch (error) { assert.match(String(error), /Octo business MCP|blocked/i); blocked = true; }
        assert.equal(blocked, external, 'nested target policy must follow session trust');
        assert.equal(calls.includes(name), !external);
      }
    } finally { clear({ catalogRef }); }
  }
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  console.log(`OpenClaw ${version}: native search/describe/call retain non-Octo tools; both Octo target forms blocked in both external task kinds and allowed in IM.`);
} finally { reset(); }
