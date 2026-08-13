import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";
import type { OctoConfig } from "./config-schema.js";
import { getChannelConfig } from "./constants.js";

export type ResolvedOctoAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: {
    botToken?: string;
    apiUrl: string;
    /**
     * 文档域(`/v1/bot/docs/**`)的 base URL。**总是有值** —— 没配就等于 `apiUrl`。
     *
     * 为什么不能直接用 `apiUrl`:文档域由**另一个服务**(docs-backend)提供。托管
     * 环境把它和 IM server 摆在同一个网关 origin 后面,所以「等于 apiUrl」是对的
     * 默认值;拆开部署的本地栈不是 —— IM 网关照常应答 `/v1/bot/**`,却没有
     * `/v1/bot/docs/**` 的路由,于是文档任务的每一条回帖都拿到 404。404 属于
     * **确定性失败**,不重试,回复直接丢掉,连兜底提示(同一个 endpoint)也发不
     * 出去;而文档本身已经改完了 —— 用户看到的就是「正文被悄悄改了、评论区一个
     * 字都没有」。
     */
    docsApiUrl: string;
    wsUrl?: string;
    cdnUrl?: string;  // CDN base URL for media files (public-read, no auth)
    pollIntervalMs: number;
    /** Server-side long-poll hold in seconds; 0 = short poll at pollIntervalMs. */
    eventWaitSeconds: number;
    heartbeatIntervalMs: number;
    requireMention?: boolean;
    historyLimit?: number;  // 群聊历史消息条数限制
    historyPromptTemplate?: string;  // Template for group history context injection
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
  // 没配就退回 apiUrl:托管环境一个网关同时前置 IM 与 docs-backend,那里两者本来
  // 就是同一个 origin。只有拆开部署的栈需要显式配置。
  const docsApiUrl = accountConfig.docsApiUrl ?? channel.docsApiUrl ?? apiUrl;
  const wsUrl = accountConfig.wsUrl ?? channel.wsUrl;
  const cdnUrl = accountConfig.cdnUrl ?? channel.cdnUrl;
  const pollIntervalMs =
    accountConfig.pollIntervalMs ??
    channel.pollIntervalMs ??
    DEFAULT_POLL_INTERVAL_MS;
  // 0/unset keeps the historical short poll; no default hold is applied, because a hold the
  // operator did not ask for would break against servers predating the `wait` field.
  const eventWaitSeconds =
    accountConfig.eventWaitSeconds ?? channel.eventWaitSeconds ?? 0;
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
      docsApiUrl,
      wsUrl,
      cdnUrl,
      pollIntervalMs,
      eventWaitSeconds,
      heartbeatIntervalMs,
      requireMention: accountConfig.requireMention ?? channel.requireMention,
      historyLimit: accountConfig.historyLimit ?? channel.historyLimit ?? 20,
      historyPromptTemplate: accountConfig.historyPromptTemplate ?? channel.historyPromptTemplate,
      // main 已废弃 cardProgress/cardDisplay/cardInteraction/reasoningCardTemplateMode 的本地
      // 透传(服务端 per-Bot 配置权威),这里不再恢复。docTasks 是本 PR 新增的本地开关,
      // 服务端没有对应字段,必须透传。
      docTasks: accountConfig.docTasks ?? channel.docTasks,
      onBehalfOf: accountConfig.onBehalfOf ?? channel.onBehalfOf,
      secretsFileRoot: accountConfig.secretsFileRoot ?? channel.secretsFileRoot,
      dispatchTimeoutMs: accountConfig.dispatchTimeoutMs ?? channel.dispatchTimeoutMs,
    },
  };
}
