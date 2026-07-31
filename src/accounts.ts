import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";
import type { OctoConfig, ReasoningCardTemplateMode } from "./config-schema.js";
import { getChannelConfig } from "./constants.js";

export type ResolvedOctoAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: {
    botToken?: string;
    apiUrl: string;
    wsUrl?: string;
    cdnUrl?: string;  // CDN base URL for media files (public-read, no auth)
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
    requireMention?: boolean;
    historyLimit?: number;  // 群聊历史消息条数限制
    historyPromptTemplate?: string;  // Template for group history context injection
    cardProgress?: boolean;  // false disables automatic progress cards for this account
    reasoningCardTemplateMode?: ReasoningCardTemplateMode;
    cardDisplay?: boolean;  // false disables the display-card tool for this account
    cardInteraction?: boolean;  // false disables interactive authoring and callback polling
    onBehalfOf?: string;  // Persona clone: grantor uid
    secretsFileRoot?: string;  // Jail root for write-secret file writes
    docTasks?: boolean;  // true 开启文档评论 @Bot 任务(常驻事件轮询 + 出站改投评论区)
    dispatchTimeoutMs?: number;  // Explicit dispatch-timeout override; unset = derive from agents.defaults.timeoutSeconds (issue #113)
  };
};

const DEFAULT_API_URL = "http://localhost:8090/api";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;

export function listOctoAccountIds(cfg: OpenClawConfig): string[] {
  const channel = getChannelConfig<OctoConfig>(cfg);
  const accountIds = Object.keys(channel.accounts ?? {});
  if (accountIds.length > 0) {
    return accountIds;
  }
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultOctoAccountId(cfg: OpenClawConfig): string | null {
  const channel = getChannelConfig<OctoConfig>(cfg);
  const accountIds = Object.keys(channel.accounts ?? {});
  // Single account or legacy config (no accounts map): safe to default
  if (accountIds.length <= 1) {
    return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
  }
  // Multiple accounts: cannot guess, caller must specify
  return null;
}

export function resolveOctoAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedOctoAccount {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const channel = getChannelConfig<OctoConfig>(params.cfg);
  // Strict lookup first; fall back to case-insensitive match because OpenClaw's
  // routing layer normalizes accountId to lowercase via normalizeAccountId
  // (canonicalizeAccountId in openclaw/dist/account-id-*.js), while botfather
  // generates mixed-case bot IDs (e.g. "27pBwzf2F6bfa5cd142_bot"). Without the
  // fallback, outbound paths that re-resolve account from the lowercased ID
  // miss the mixed-case config key and throw "botToken is not configured",
  // silently dropping replies. Long-term, botfather should produce lowercase
  // IDs to match OpenClaw's contract; this bridges the gap and keeps working
  // for historical mixed-case bot IDs already in production.
  const accountConfig =
    channel.accounts?.[accountId]
    ?? Object.entries(channel.accounts ?? {}).find(
      ([key]) => key.toLowerCase() === accountId.toLowerCase(),
    )?.[1]
    ?? channel;

  const botToken = accountConfig.botToken ?? channel.botToken;
  const apiUrl = accountConfig.apiUrl ?? channel.apiUrl ?? DEFAULT_API_URL;
  const wsUrl = accountConfig.wsUrl ?? channel.wsUrl;
  const cdnUrl = accountConfig.cdnUrl ?? channel.cdnUrl;
  const pollIntervalMs =
    accountConfig.pollIntervalMs ??
    channel.pollIntervalMs ??
    DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs =
    accountConfig.heartbeatIntervalMs ??
    channel.heartbeatIntervalMs ??
    DEFAULT_HEARTBEAT_INTERVAL_MS;

  const enabled = accountConfig.enabled ?? channel.enabled ?? true;
  const configured = Boolean(botToken?.trim());

  return {
    accountId,
    name: accountConfig.name ?? channel.name,
    enabled,
    configured,
    config: {
      botToken,
      apiUrl,
      wsUrl,
      cdnUrl,
      pollIntervalMs,
      heartbeatIntervalMs,
      requireMention: accountConfig.requireMention ?? channel.requireMention,
      historyLimit: accountConfig.historyLimit ?? channel.historyLimit ?? 20,
      historyPromptTemplate: accountConfig.historyPromptTemplate ?? channel.historyPromptTemplate,
      cardProgress: accountConfig.cardProgress ?? channel.cardProgress,
      reasoningCardTemplateMode: accountConfig.reasoningCardTemplateMode ?? channel.reasoningCardTemplateMode,
      cardDisplay: accountConfig.cardDisplay ?? channel.cardDisplay,
      cardInteraction: accountConfig.cardInteraction ?? channel.cardInteraction,
      docTasks: accountConfig.docTasks ?? channel.docTasks,
      onBehalfOf: accountConfig.onBehalfOf ?? channel.onBehalfOf,
      secretsFileRoot: accountConfig.secretsFileRoot ?? channel.secretsFileRoot,
      dispatchTimeoutMs: accountConfig.dispatchTimeoutMs ?? channel.dispatchTimeoutMs,
    },
  };
}
