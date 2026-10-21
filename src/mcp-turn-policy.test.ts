import { describe, expect, it, vi } from 'vitest';
import plugin from '../index.js';
import { pendingInboundContext } from './inbound.js';
vi.mock('openclaw/plugin-sdk/channel-entry-contract', () => ({ defineBundledChannelEntry: (entry: unknown) => entry }));
function setup(current = () => ({ mcp: { servers: { 'octo-mcp': { transport: 'streamable-http', url: 'https://mcp.example.test/' } } } })) {
  const hooks = new Map<string, any[]>();
  (plugin as any).registerCapabilities({ config: {}, runtime: { config: { current } }, registerMcpServerConnectionResolver: vi.fn(), on: (name: string, fn: any) => hooks.set(name, [...(hooks.get(name) ?? []), fn]) });
  (plugin as any).registerFull({ registrationMode: 'full', config: {}, runtime: { config: { current } }, logger: { warn: vi.fn(), info: vi.fn() }, registerTool: vi.fn(), registerChannel: vi.fn(), registerMcpServerConnectionResolver: vi.fn(), on: (name: string, fn: any) => hooks.set(name, [...(hooks.get(name) ?? []), fn]) });
  return { prompt: (event: any, ctx: any) => { const results = (hooks.get('before_prompt_build') ?? []).map(fn => fn(event, ctx)); return {prependSystemContext: results.map(x => x?.prependSystemContext).filter(Boolean).join('\n\n'), prependContext: results.map(x => x?.prependContext).filter(Boolean).join('\n\n')}; }, before: (name: string, sessionKey: string) => (hooks.get('before_tool_call') ?? []).map(fn => fn({toolName: name, params: {}}, {sessionKey, runId: 'run'})).find(x => x?.block) };
}
describe('MCP authority and diagnostic through plugin hooks', () => {
  it.each(['doctask:doc:comment', 'octo:bot-task:bot:loop:issue'])('blocks business tools in external task %s', scope => {
    const {before} = setup();
    for (const tool of ['mcp__octo-mcp__execute', 'mcp__octo_mcp__call_op', 'mcp__octo-mcp-2__execute', 'octo-mcp__execute', 'octo-mcp__call_op', 'octo-business__execute', 'octo-mcp-2__execute', 'octo_mcp-12__call_op', 'sessions_spawn', 'sessions_yield', 'sessions_send']) expect(before(tool, 'agent:main:octo:acct:'+scope)).toMatchObject({block: true});
    for (const tool of ['exec', 'tool_call', 'tool_search', 'tool_describe', 'mcp__github__lookup']) expect(before(tool, 'agent:main:octo:acct:'+scope)).toBeUndefined();
  });
  it('leaves ordinary IM business and delegation calls allowed', () => { for (const tool of ['tool_call', 'tool_search', 'tool_describe', 'mcp__octo-mcp__execute', 'octo-mcp__execute', 'sessions_spawn', 'sessions_yield', 'sessions_send']) expect(setup().before(tool, 'agent:main:octo:acct:group:one')).toBeUndefined(); });
  it('retains legacy task delegation when MCP is not configured', () => {
    for (const tool of ['tool_call', 'tool_search', 'tool_describe', 'sessions_spawn', 'sessions_yield', 'sessions_send']) expect(setup(() => ({} as any)).before(tool, 'agent:main:octo:acct:octo:bot-task:bot:loop:issue')).toBeUndefined();
  });
  it('retains the existing security diagnostic alongside MCP guidance', () => {
    const result = setup().prompt({}, {messageProvider:'octo',sessionKey:'agent:main:octo:acct:dm:human'});
    expect(result.prependSystemContext).toContain('octo-mcp'); expect(result.prependSystemContext).toContain('octo_management'); expect(result.prependSystemContext.toLowerCase()).toContain('plaintext');
    expect(result.prependSystemContext).toContain('get_skill is a tool, never an execute operation_id');
    expect(result.prependSystemContext).toContain('spelling suggestions, not the complete operation catalog');
    expect(result.prependSystemContext).toContain('dry_run only previews');
    expect(result.prependSystemContext).toContain('get_skill intent=describe in the two-tool facade, or describe_op in the three-tool facade');
    expect(result.prependSystemContext).toContain('including header keys such as If-Match');
    expect(result.prependSystemContext).toContain('inside execute.arguments');
    expect(result.prependSystemContext).toContain('never channel delivery routes');
  });
  it('returns the diagnostic if the runtime configuration read throws', () => {
    const sessionKey = 'agent:main:octo:acct:dm:human';
    const pending = {sessionKey, accountId:'acct', historyPrefix:'retained history', memberListPrefix:'retained members'};
    pendingInboundContext.set('config-error-run', pending);
    const result = setup(() => { throw Error('config unavailable'); }).prompt({}, {messageProvider:'octo',sessionKey,runId:'config-error-run'});
    expect(result.prependSystemContext).toContain('octo_management');
    expect(result.prependContext).toContain('retained history');
    expect(result.prependContext).toContain('retained members');
  });
  it('does not advertise unusable endpoints or external task MCP', () => {
    const invalid = setup(() => ({mcp:{servers:{'octo-mcp':{transport:'streamable-http',url:'http://remote.example/'}}}}));
    expect(invalid.prompt({}, {messageProvider:'octo'}).prependSystemContext).not.toContain('Use the configured octo-mcp');
    expect(setup().prompt({}, {messageProvider:'octo',sessionKey:'agent:main:octo:acct:doctask:doc:comment'}).prependSystemContext).not.toContain('Use the configured octo-mcp');
  });
});
