import { describe, expect, it, vi } from 'vitest';
import { registerOctoMcpConnection, resolveOctoMcpConnection } from './mcp-connection.js';

const ctx = { messageChannel: 'octo', agentAccountId: 'bot_a', requesterSenderId: 'human' };
const config = () => ({
  channels: { octo: { botToken: 'bf_global', accounts: {
    Bot_A: { botToken: 'bf_a' }, bot_b: { botToken: 'bf_b' },
  } } },
  mcp: { servers: { 'octo-mcp': { enabled: true, transport: 'streamable-http', url: 'https://mcp.example.test/' } } },
});
describe('Octo requester-bound MCP', () => {
  it('requires migration of the old service name before enabling a release default', () => {
    const cfg: any = config();cfg.mcp.servers['octo-business'] = { enabled: false };
    expect(resolveOctoMcpConnection(cfg, ctx, 'https://deployment.test/')).toBeNull();
  });
  it('uses the deployment-bundled endpoint without user configuration, respecting explicit disable', () => {
    const cfg: any = config(); delete cfg.mcp;
    expect(resolveOctoMcpConnection(cfg, ctx, 'https://deployment.test/')?.headers.Authorization).toBe('Bearer bf_a');
    cfg.mcp = { servers: { 'octo-mcp': { enabled: false } } };
    expect(resolveOctoMcpConnection(cfg, ctx, 'https://deployment.test/')).toBeNull();
  });
  it('reuses each existing bound account without putting credentials into static config', () => {
    const cfg = config();
    const before = JSON.stringify(cfg);
    expect(resolveOctoMcpConnection(cfg, ctx)?.headers).toEqual({ Authorization: 'Bearer bf_a' });
    expect(resolveOctoMcpConnection(cfg, { ...ctx, agentAccountId: 'bot_b' })?.headers)
      .toEqual({ Authorization: 'Bearer bf_b' });
    expect(JSON.stringify(cfg)).toBe(before);
  });
  it.each([
    { ...ctx, agentAccountId: 'unknown' }, { ...ctx, agentAccountId: undefined },
    { ...ctx, requesterSenderId: '' }, { ...ctx, messageChannel: 'webchat' },
  ])('refuses absent or foreign host identity %j', (context) => {
    expect(resolveOctoMcpConnection(config(), context)).toBeNull();
  });
  it('matches native canonical account IDs and rejects collisions', () => {
    const cfg: any = config();
    cfg.channels.octo.accounts = { 'My Bot': { botToken: 'bf_legacy' } };
    expect(resolveOctoMcpConnection(cfg, { ...ctx, agentAccountId: 'my-bot' })?.headers.Authorization).toBe('Bearer bf_legacy');
    cfg.channels.octo.accounts['my-bot'] = { botToken: 'bf_other' };
    expect(resolveOctoMcpConnection(cfg, { ...ctx, agentAccountId: 'my-bot' })).toBeNull();
  });
  it('does not borrow global credentials for a named account without its own token', () => {
    const cfg = config(); delete (cfg.channels.octo.accounts.Bot_A as any).botToken;
    expect(resolveOctoMcpConnection(cfg, ctx)).toBeNull();
  });
  it('supports the explicit legacy default account only', () => {
    const cfg = config(); delete (cfg.channels.octo as any).accounts;
    expect(resolveOctoMcpConnection(cfg, { ...ctx, agentAccountId: 'default' })?.headers)
      .toEqual({ Authorization: 'Bearer bf_global' });
    expect(resolveOctoMcpConnection(cfg, ctx)).toBeNull();
  });
  it('refuses case-colliding accounts and disabled accounts or channels', () => {
    const cfg = config(); (cfg.channels.octo.accounts as any).bot_a = { botToken: 'bf_other' };
    expect(resolveOctoMcpConnection(cfg, ctx)).toBeNull();
    delete (cfg.channels.octo.accounts as any).bot_a;
    (cfg.channels.octo.accounts.Bot_A as any).enabled = false;
    expect(resolveOctoMcpConnection(cfg, ctx)).toBeNull();
    delete (cfg.channels.octo.accounts.Bot_A as any).enabled;
    (cfg.channels.octo as any).enabled = false;
    expect(resolveOctoMcpConnection(cfg, ctx)).toBeNull();
  });
  it.each(['http://remote.example/', 'https://user:secret@example.test/', 'file:///tmp/mcp', 'https://mcp.test/#token'])
    ('refuses unsafe credential destinations: %s', (url) => {
      const cfg = config(); cfg.mcp.servers['octo-mcp'].url = url;
      expect(resolveOctoMcpConnection(cfg, ctx)).toBeNull();
    });
  it('accepts explicitly configured loopback HTTP for local deployment', () => {
    const cfg = config(); cfg.mcp.servers['octo-mcp'].url = 'http://127.0.0.1:29861/';
    expect(resolveOctoMcpConnection(cfg, ctx)?.url).toBe('http://127.0.0.1:29861/');
  });
  it('rejects static credentials, non-HTTP transports and disabled services', () => {
    for (const patch of [{ headers: { Authorization: 'Bearer wrong' } }, { auth: {} },
      { transport: 'sse' }, { enabled: false }, { clientCert: '/fixture/cert.pem' }, { clientKey: '/fixture/key.pem' }, { sslVerify: false }]) {
      const cfg = config(); Object.assign(cfg.mcp.servers['octo-mcp'], patch);
      expect(resolveOctoMcpConnection(cfg, ctx)).toBeNull();
    }
  });
  it('reads current config on every resolution, including token rotation', () => {
    let cfg = config(); let resolver: any;
    registerOctoMcpConnection({ config: cfg, runtime: { config: { current: () => cfg } },
      registerMcpServerConnectionResolver: (value: any) => { resolver = value; } } as any);
    expect(resolver.serverName).toBe('octo-mcp');
    cfg = config(); cfg.channels.octo.accounts.Bot_A.botToken = 'bf_rotated';
    expect(resolver.resolve(ctx)?.headers.Authorization).toBe('Bearer bf_rotated');
  });
  it('keeps old hosts compatible unless MCP is explicitly enabled', () => {
    expect(registerOctoMcpConnection({ config: {} } as any)).toBe(false);
    const warn = vi.fn();
    expect(registerOctoMcpConnection({ config: config(), logger: { warn } } as any)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/MCP.*host/i));
  });
  it('fails closed when current configuration cannot be read', () => {
    let resolver: any;
    registerOctoMcpConnection({ config: config(), runtime: { config: { current: vi.fn(() => { throw Error('unavailable'); }) } },
      registerMcpServerConnectionResolver: (value: any) => { resolver = value; } } as any);
    expect(resolver.resolve(ctx)).toBeNull();
  });
});
