import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { normalizeOptionalAccountId } from 'openclaw/plugin-sdk/routing';
import { isExternalTaskSessionKey } from './constants.js';
import { BUNDLED_MCP_URL } from './mcp-deployment.js';

/** Reserved for the Octo business service; channel login and egress stay local. */
export const OCTO_MCP_SERVER_NAME = 'octo-mcp';

type Context = { requesterSenderId: string; agentAccountId?: string; messageChannel?: string };
type Connection = { url: string; headers: Record<string, string> };
type ResolverApi = OpenClawPluginApi & {
  registerMcpServerConnectionResolver?: (resolver: {
    serverName: string; resolve: (context: Context) => Connection | null;
  }) => void;
};
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : {};
}

export function octoMcpEnabled(config: unknown): boolean {
  return resolveEndpoint(config) !== null;
}

function resolveEndpoint(config: unknown, bundledUrl = BUNDLED_MCP_URL): string | null {
  const root = record(config);
  // The updater owns renaming and preserving old denials; do not bypass them
  // with the new bundled declaration during a direct plugin-only update.
  if (Object.hasOwn(record(record(root.mcp).servers), 'octo-business')) return null;
  const channel = record(record(root.channels).octo);
  if (channel.enabled === false) return null;
  const configured = record(record(root.mcp).servers)[OCTO_MCP_SERVER_NAME];
  const server = configured === undefined && bundledUrl
    ? { enabled: true, transport: 'streamable-http', url: bundledUrl }
    : record(configured);
  if (server.enabled === false || server.transport !== 'streamable-http'
    || typeof server.url !== 'string') return null;
  // Reject static identity/auth: an unknown account must never borrow another Bot's credential.
  if (['headers', 'auth', 'oauth', 'command', 'args', 'env', 'type', 'clientCert', 'clientKey'].some(key => key in server) || server.sslVerify === false) return null;
  let url: URL;
  try { url = new URL(server.url); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.hash || url.search) return null;
  return url.href;
}

/** Operator-selected endpoint only. Never derive a credential destination from a message. */
export function resolveOctoMcpConnection(config: unknown, context: Context, bundledUrl = BUNDLED_MCP_URL): Connection | null {
  if (context.messageChannel !== 'octo' || !context.requesterSenderId?.trim()
    || !context.agentAccountId?.trim()) return null;
  const endpoint = resolveEndpoint(config, bundledUrl);
  if (!endpoint) return null;
  const channel = record(record(record(config).channels).octo);
  const accounts = record(channel.accounts);
  const accountId = normalizeOptionalAccountId(context.agentAccountId);
  if (!accountId) return null;
  const matches = Object.keys(accounts).filter(key => normalizeOptionalAccountId(key) === accountId);
  let account: RecordValue;
  if (Object.keys(accounts).length === 0 && accountId === 'default') account = channel;
  else if (matches.length === 1) account = record(accounts[matches[0]]);
  else return null;
  // Deliberately avoid resolveOctoAccount's top-level fallback for named accounts.
  const token = account.botToken;
  if (account.enabled === false || typeof token !== 'string' || !token.trim()
    || /[\r\n]/.test(token)) return null;
  return { url: endpoint, headers: { Authorization: `Bearer ${token.trim()}` } };
}

export function registerOctoMcpConnection(api: OpenClawPluginApi): boolean {
  const host = api as ResolverApi;
  if (typeof host.registerMcpServerConnectionResolver !== 'function') {
    if (octoMcpEnabled(api.config)) {
      api.logger?.warn('Octo MCP requires a host with registerMcpServerConnectionResolver; upgrade OpenClaw to use octo-mcp. Existing channel connections are retained.');
    }
    return false;
  }
  host.registerMcpServerConnectionResolver({
    serverName: OCTO_MCP_SERVER_NAME,
    resolve(context) {
      // No stale token fallback if live config is unavailable, disabled or rotated.
      try { return resolveOctoMcpConnection(api.runtime.config.current(), context); }
      catch { return null; }
    },
  });
  return true;
}

export const OCTO_MCP_TOOL_HINT =
  'Use the configured octo-mcp MCP tools for supported Octo business operations. ' +
  'Discover the operation and its schema before executing. With the two-tool facade, call the advertised get_skill tool directly: intent=search discovers operations and intent=describe returns the schema; then call execute with the discovered operation_id. ' +
  'get_skill is a tool, never an execute operation_id. With the three-tool facade, call search_ops, describe_op, then call_op. Use the actual advertised names, including any host prefix. ' +
  'If the host exposes tool_search/tool_describe/tool_call, discover the exact prefixed MCP tool name before invoking it; use get_skill intent=describe in the two-tool facade, or describe_op in the three-tool facade, to obtain parameter schemas. ' +
  'Put all declared business parameters inside execute.arguments (or call_op.arguments), including If-Match; never put them at the tool wrapper level. ' +
  'Use declared wire argument names, including header keys such as If-Match; do not substitute CLI flag spellings. MCP channel_id and uid use raw business IDs, never channel delivery routes such as octo:user:<uid>, user:<uid> or group:<id>. ' +
  'Unknown-operation candidates are spelling suggestions, not the complete operation catalog. A successful dry_run only previews a request and never completes a requested real change. The host supplies the current Bot identity; ' +
  'never ask the user or model to supply Bot tokens. If MCP tools are unavailable, report the connection or tool policy problem. ' +
  'Keep normal channel replies on the existing Octo channel. Document/PPT background tasks and workflows not yet supported by MCP retain their existing CLI paths.';

/** Prepared Agent registries need protocol guidance as well as connection identity. */
export function registerOctoMcpPromptHint(api: OpenClawPluginApi): void {
  api.on('before_prompt_build', (_event, ctx) => {
    if (ctx.messageProvider !== 'octo' || isExternalTaskSessionKey(ctx.sessionKey)) return;
    try {
      if (octoMcpEnabled(api.runtime.config.current())) return { prependSystemContext: OCTO_MCP_TOOL_HINT };
    } catch {
      // Leave the existing full-mode history and management diagnostics untouched.
    }
  });
}

/** Cached account connections do not grant Bot authority to lower-trust task turns. */
export function registerOctoMcpToolPolicy(api: OpenClawPluginApi): void {
  api.on('before_tool_call', (event, ctx) => {
    if (!isExternalTaskSessionKey(ctx.sessionKey)) return;
    // Delegated child sessions lose the external-task marker but can inherit
    // the sender/account. Keep Bot authority from escaping through a child.
    const delegates = ['sessions_spawn', 'sessions_yield', 'sessions_send'].includes(event.toolName);
    const businessTool = /^(?:mcp__)?octo[-_](?:mcp|business)(?:-[0-9]+)?__/i.test(event.toolName);
    // Native Tool Search calls each catalog target through this same hook.
    // Guard the actual target, preserving unrelated catalog tools for tasks.
    if (!delegates && !businessTool) return;
    if (!businessTool) {
      if (typeof (api as ResolverApi).registerMcpServerConnectionResolver !== 'function') return;
      try { if (!octoMcpEnabled(api.runtime.config.current())) return; }
      catch { /* Cached MCP connections may still exist: fail closed. */ }
    }
    return { block: true, blockReason: 'Octo business MCP is unavailable in external task sessions: Bot-level authority is not scoped to the external task actor. Use only the output mechanism specified by the task.' };
  }, { priority: 100 });
}
