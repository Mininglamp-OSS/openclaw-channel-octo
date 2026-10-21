import { describe, expect, it, vi } from 'vitest';
import plugin from '../index.js';

// Keep the host's real registration-mode routing; substitute only filesystem-loaded
// channel/runtime modules, which Vitest cannot resolve through the host loader.
vi.mock('openclaw/plugin-sdk/channel-entry-contract', async importOriginal => {
  const actual = await importOriginal<any>();
  return { ...actual, defineBundledChannelEntry: (options: any) => actual.defineBundledChannelEntry({
    ...options, plugin: { specifier: './src/version.ts', exportName: 'PLUGIN_VERSION' }, runtime: undefined,
  }) };
});

describe('MCP identity across host registration modes', () => {
  it.each(['full', 'discovery', 'tool-discovery'])('registers the account resolver once in %s', mode => {
    const registered: any[] = [];
    const hooks = new Map<string, any[]>();
    const cfg = { channels: { octo: { accounts: { a: { botToken: 'bf_a' }, b: { botToken: 'bf_b' } } } },
      mcp: { servers: { 'octo-mcp': { transport: 'streamable-http', url: 'https://mcp.example.test/' } } } };
    plugin.register({ registrationMode: mode, config: cfg, runtime: { config: { current: () => cfg } },
      logger: { warn: vi.fn(), info: vi.fn() }, registerChannel: vi.fn(), registerTool: vi.fn(), on: (name: string, fn: any) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
      registerMcpServerConnectionResolver: (resolver: any) => registered.push(resolver),
    } as any);
    expect(registered).toHaveLength(1);
    const promptResults = (hooks.get('before_prompt_build') ?? []).map(fn => fn({}, {messageProvider:'octo',sessionKey:'agent:main:octo:acct:dm:human'}));
    expect(promptResults.filter(x => x?.prependSystemContext?.includes('get_skill is a tool'))).toHaveLength(1);

    const vetoes = hooks.get('before_tool_call') ?? [];
    // Other existing policies may register in full mode; only the MCP veto is
    // relevant to this public operation and must run exactly once.
    for (const scope of ['doctask:doc:comment', 'octo:bot-task:bot:loop:issue']) {
      for (const name of ['mcp__octo-mcp__execute', 'mcp__octo_mcp-2__call_op', 'octo-mcp__execute', 'octo-mcp-2__call_op', 'sessions_spawn', 'sessions_yield', 'sessions_send']) {
        const results = vetoes.map(fn => fn({ toolName: name, params: { name: 'octo-mcp__execute', arguments: { operation_id: 'fixture.write' } } }, { sessionKey: 'agent:main:octo:acct:' + scope, runId: 'run' }));
        expect(results.filter(x => x?.block && x.blockReason?.startsWith('Octo business MCP'))).toHaveLength(1);
        expect(results.some(x => x?.block)).toBe(true);
      }
    }
    expect(vetoes.map(fn => fn({ toolName: 'octo-mcp__execute', params: {} }, { sessionKey: 'agent:main:octo:acct:dm:human' })).filter(x => x?.block)).toHaveLength(0);

    const ctx = { requesterSenderId: 'human', messageChannel: 'octo', agentAccountId: 'a' };
    expect(registered[0].resolve(ctx)?.headers.Authorization).toBe('Bearer bf_a');
    expect(registered[0].resolve({ ...ctx, agentAccountId: 'b' })?.headers.Authorization).toBe('Bearer bf_b');
    expect(registered[0].resolve({ ...ctx, agentAccountId: 'unknown' })).toBeNull();
  });
});
