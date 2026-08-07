/**
 * agent 展示卡工具 —— `octo_send_display_card`
 *
 * 让 agent 在一次 turn 内主动发一张**展示型** InteractiveCard(17)到当前会话:
 * 标题 + 富展示 block(TextBlock/RichTextBlock/ColumnSet/FactSet/Table/Container/collapsible/copy/link …)。
 *
 * 与 P2 的 `octo_send_card`(带 Action.Submit 按钮、点击回流 card_action 触发新 turn)
 * 严格区分:本工具**顶层无回调 actions、不产生回流事件** —— agent 无需处理点击回调。
 * block 内可包含客户端本地动作(如复制到剪贴板),但不会触发 bot callback。
 *
 * 安全:
 *   - 入参 `blocks` 是 agent 可控输入,经 `validateDisplayBlocks` 白名单结构校验;
 *   - 内容再由 `buildDisplayCard` 逐 block 脱敏(URL 降级、命中 secret 抹除);
 *   - 出站前 D12 gate:manifest disabled / profile 不含 `octo/v1` / card_version 不兼容
 *     → 拒绝(fail-closed),避免服务端 400。
 *   - caps.elements 未 advertise 的元素自动降级,agent 无需自己判断白名单。
 *   - 发送目标只取 runtime-owned deliveryContext;模型不能通过 channelId/threadId 跨会话发送。
 *   - **身份不接受 agent 入参**:展示卡始终以 bot 自身身份发出,OBO(persona-clone)绝不由
 *     不可信模型输入指定(与进度卡路径一致,OBO 一律跳过),避免群可见卡片成为 persona 冒充 sink。
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { listOctoAccountIds, resolveOctoAccount } from "./accounts.js";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { sendCardMessage, generateClientMsgNo, type CardProfileManifest } from "./api-fetch.js";
import { getBotCardProfile, peekBotCardProfile } from "./card-profile-cache.js";
import { buildDisplayCard, validateDisplayBlocks } from "./card-blocks.js";
import { deriveCardCaps } from "./card-caps.js";
import { isSensitive, reduceUrlsInText } from "./card-render.js";
import { resolveOutboundOctoTarget } from "./actions.js";
import type { CardCaps } from "./card-render.js";
import { ChannelType, CARD_PROFILE, CARD_VERSION } from "./types.js";
import { CHANNEL_ID, DISPLAY_CARD_TOOL_NAME } from "./constants.js";
import { requestCardEventPolling } from "./events-poll.js";

/** 展示卡发送超时(postJson 无默认超时,防挂起的 POST 拖死 tool 调用)。 */
const SEND_TIMEOUT_MS = 15_000;
const REQUEST_LOG_FILE = "display-card-requests.jsonl";
const DEBUG_STRING_MAX = 512;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown; // SDK ErasedAgentToolExecute requires this key present(可为 null)
}

function ok(msg: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text: msg }], details: details ?? null };
}

function err(msg: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${msg}` }], details: null };
}

function redactDebugValue(value: unknown): unknown {
  if (typeof value === "string") {
    const reduced = reduceUrlsInText(value).replace(/\s+/g, " ").trim();
    if (!reduced) return reduced;
    if (isSensitive(reduced, true)) return "[redacted]";
    return reduced.length > DEBUG_STRING_MAX ? `${reduced.slice(0, DEBUG_STRING_MAX)}…` : reduced;
  }
  if (Array.isArray(value)) return value.map((v) => redactDebugValue(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|passwd|pwd|authorization|bearer|api[_-]?key|client[_-]?secret/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redactDebugValue(v);
      }
    }
    return out;
  }
  return value;
}

function manifestForDebug(m: CardProfileManifest): Record<string, unknown> {
  return {
    available: m.available,
    enabled: m.enabled,
    profiles: m.profiles,
    card_version: m.card_version,
    elements: m.elements,
    actions: m.actions,
    limits: m.limits,
    config: m.config,
  };
}

async function recordDisplayCardRequest(entry: Record<string, unknown>): Promise<void> {
  const dir = process.env.OCTO_CARD_REQUEST_LOG_DIR;
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, REQUEST_LOG_FILE), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (e) {
    // Debug recording must never affect message delivery.
    // eslint-disable-next-line no-console -- env-gated diagnostic sink
    console.warn(`[octo:display-card] failed to record request: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * gate 校验：服务端 Bot 策略未明确允许 / profile 不含 octo/v1 / card_version 不匹配
 * 均拒绝；不读取本地配置兜底。
 */
function gateReason(m: CardProfileManifest): string | null {
  if (!m.available || m.config?.display_enabled !== true) {
    return "display cards are disabled by the server Bot policy";
  }
  if (Array.isArray(m.profiles) && m.profiles.length > 0 && !m.profiles.includes(CARD_PROFILE)) {
    return `profile ${CARD_PROFILE} not advertised by server (got: ${m.profiles.join(",")})`;
  }
  if (typeof m.card_version === "string" && m.card_version !== CARD_VERSION) {
    return `card_version ${m.card_version} not compatible (need ${CARD_VERSION})`;
  }
  if (Array.isArray(m.elements) && !m.elements.includes("TextBlock")) {
    return "TextBlock is not advertised; no safe display-card fallback is available";
  }
  return null;
}

interface Params {
  cfg?: OpenClawConfig;
  agentAccountId?: string;
  agentId?: string;
  /** Runtime-owned current delivery route. Model arguments are never used for authorization. */
  deliveryContext?: OpenClawPluginToolContext["deliveryContext"];
  messageChannel?: string;
}

/**
 * 创建 agent 展示卡工具。无 configured account → 返回空数组(tool-discovery 阶段安全)。
 */
export function createDisplayCardTool(params: Params): Array<{
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<ToolResult>;
}> {
  const { cfg, agentAccountId, deliveryContext, messageChannel } = params;
  if (!cfg) return [];
  const ambientChannel = deliveryContext?.channel ?? messageChannel;
  // Plugin tools are registered globally. An explicit non-Octo ambient route must never expose
  // an Octo side-effect tool to another provider's conversation.
  if (ambientChannel && ambientChannel !== CHANNEL_ID) return [];
  try {
    const ids = listOctoAccountIds(cfg);
    const configuredAccounts = ids
      .map((id) => resolveOctoAccount({ cfg, accountId: id }))
      .filter((acct) => acct.enabled && acct.configured && !!acct.config.botToken);
    if (configuredAccounts.length === 0) return [];
    // Discovery is synchronous. Hide only on a cached authoritative server decision; an unknown
    // profile stays visible so execute can perform the authoritative async read.
    const discoveryAccountId = deliveryContext?.accountId
      ?? agentAccountId
      ?? (ids.length === 1 ? ids[0] : undefined);
    if (discoveryAccountId) {
      const discoveryAccount = resolveOctoAccount({ cfg, accountId: discoveryAccountId });
      if (discoveryAccount.config.botToken &&
          peekBotCardProfile({
            apiUrl: discoveryAccount.config.apiUrl,
            botToken: discoveryAccount.config.botToken,
          })?.config?.display_enabled === false) return [];
    } else if (configuredAccounts.every((account) =>
      !!account.config.botToken && peekBotCardProfile({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
      })?.config?.display_enabled === false)) {
      return [];
    }
  } catch {
    return [];
  }

  const tool = {
    name: DISPLAY_CARD_TOOL_NAME,
    label: "Octo Send Display Card",
    description:
      "Send a DISPLAY card (Adaptive Card 1.5) to the current Octo conversation. The target " +
      "comes from trusted runtime delivery context and cannot be selected by tool arguments. Use this for rich, " +
      "structured, NON-INTERACTIVE output — status reports, structured answers, key-value " +
      "summaries, three-column KPI/weather summary strips, tables, collapsible detail sections, local copy-to-clipboard buttons, and " +
      "safe navigation links. The card " +
      "does NOT have callback buttons and will NOT trigger any callback event; if you need " +
      "buttons that call back to you, do not use this tool. " +
      "Provide `blocks`, an ordered list of typed display blocks (heading / text / rich / " +
      "facts / columns / table / link / group / collapsible / copy); the server's advertised element/action set is negotiated " +
      "automatically and unsupported types degrade to plain text — you never need to check " +
      "compatibility yourself. " +
      "For visual emphasis, use `group` block styles sparingly: `emphasis` for neutral callouts, " +
      "`good` / `warning` / `attention` only for real success, pending, or risk states. Do not wrap " +
      "ordinary information cards, weather summaries, or copy buttons in a large green/amber/pink block; " +
      "highlight important tokens with `rich` segment colors instead " +
      "of recoloring whole lines. Design for IM: the visible first screen should be a " +
      "3-6 line summary, not a log dump. Prefer ONE title, one compact process summary, " +
      "answer summary content, and folded details. Put 2-3 `reasoning_sections` inside " +
      "the `查看过程` detail, not on the first screen. Convert raw `tool_events` into " +
      "`reasoning_sections`: each stage needs a human-readable reasoning sentence, with " +
      "tool names/short args only as evidence under the stage. Truncate long " +
      "paths/errors/queries to roughly 80-120 characters and put full details behind " +
      "`collapsible`. See SKILL.md \"Visual styling recipes\" for full " +
      "examples. If you need to show the reasoning/tool process, put it as the first " +
      "`collapsible` block in this same display card with actionLabel:'查看过程'; do not send " +
      "a separate final process-only card. " +
      "`plain` is first-class fallback/search text: generate it from the same source, keep " +
      "the title deduped, and do not concatenate raw logs into it. " +
      "Content is fully visible to all group members: never put secrets or tokens into any " +
      "field. " +
      "IMPORTANT — this tool is a side-effect that posts a card; it is NOT your conversational " +
      "reply. After it returns you MUST still emit a short final text message to the user (a " +
      "one-line summary, the answer to their question, or a next-step note). Never end your " +
      "turn on this (or any) tool call with no text: a turn that finishes with zero text output " +
      "is judged incomplete and shown to the user as an interrupted/failed turn.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional bold title rendered at the top of the card.",
        },
        blocks: {
          type: "array",
          description:
            "Ordered list of DisplayBlock. Each block is one of: " +
            "{type:'heading', text, size?:'medium'|'large'} · " +
            "{type:'text', text} · " +
            "{type:'rich', segments:[{text, bold?, fontType?:'Monospace', color?:'good'|'warning'|'attention'|'accent'}]} · " +
            "{type:'facts', items:[{label, value}]} · " +
            "{type:'columns', columns:[{blocks:[…]}]} for summary blocks such as weather / temperature / rain chance · " +
            "{type:'table', columns?:[{width:number}], rows:[{cells:[{text}|{blocks:[…]}]}], firstRowAsHeader?:boolean} · " +
            "{type:'link', text:string, url:string} for selectAction Action.OpenUrl navigation · " +
            "{type:'group', style?:'good'|'warning'|'attention'|'emphasis', blocks:[…]} · " +
            "{type:'collapsible', summary, actionLabel?:string, expandLabel?:string, collapseLabel?:string, defaultVisible?:boolean, blocks:[…]} (process cards render the toggle in a right-side ColumnSet) · " +
            "{type:'copy', label?:string, text:string} for a local Action.CopyToClipboard button. " +
            "Unknown block types or missing fields are silently dropped.",
          items: { type: "object" },
        },
      },
      required: ["blocks"],
    },
    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      try {
        if (deliveryContext?.channel !== CHANNEL_ID || !deliveryContext.to?.trim()) {
          return err("trusted current Octo delivery context is unavailable");
        }
        const validated = validateDisplayBlocks(args.blocks);
        const rawTitle = typeof args.title === "string" ? args.title : "";

        // Account 解析优先使用 runtime 当前 delivery route。agentAccountId 仅作为同一 run 的
        // 次级可信上下文;模型没有 accountId 参数,不能跨账号选目标。
        if (
          deliveryContext.accountId &&
          agentAccountId &&
          deliveryContext.accountId.toLowerCase() !== agentAccountId.toLowerCase()
        ) {
          return err("trusted delivery account does not match the active agent account");
        }
        const requestedAccountId = deliveryContext.accountId
          ?? agentAccountId
          ?? (listOctoAccountIds(cfg).length === 1 ? listOctoAccountIds(cfg)[0] : undefined);
        if (!requestedAccountId) return err("no configured Octo account available");
        const acct = resolveOctoAccount({ cfg, accountId: requestedAccountId });
        if (!acct.enabled || !acct.configured || !acct.config.botToken) {
          return err("Octo account is not fully configured");
        }
        const apiUrl = acct.config.apiUrl;
        const botToken = acct.config.botToken;
        if (!apiUrl) return err("apiUrl not configured");

        // D12 能力探测(gate + caps)。
        let manifest: CardProfileManifest;
        try {
          requestCardEventPolling(acct.accountId);
          manifest = await getBotCardProfile({ apiUrl, botToken });
        } catch (e) {
          return err(`card profile probe failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        const rejection = gateReason(manifest);
        if (rejection) return err(`${rejection}. Send your reply as a plain text message instead.`);

        // 构建 + 协商降级 + 脱敏 —— buildDisplayCard 单点权威。
        const { card, plain } = buildDisplayCard({
          title: rawTitle,
          blocks: validated,
          caps: deriveCardCaps(manifest),
        });
        // body 空 = 校验后无合法 block 且无有效 title → 空卡无意义。
        const body = (card.body as unknown[]) ?? [];
        if (body.length === 0) return err("card is empty (no valid blocks after validation)");

        // 只从 runtime-owned deliveryContext 解析当前会话。args 中即便夹带 channelId/threadId
        // 也完全忽略,它们既不是路由来源,更不是授权凭据。
        const target = resolveOutboundOctoTarget(deliveryContext.to, deliveryContext.threadId);

        // 身份**不**接受 agent 入参:OBO(persona-clone)是可信运行时/服务端授权语义,绝不能由不可信的
        // 模型输入指定,否则群可见卡片就成了 persona 冒充的 sink。与进度卡路径一致(OBO 一律跳过);
        // 展示卡始终以 bot 自身身份发出。若日后需要 persona 展示卡,应从 inbound 的可信 effectiveOnBehalfOf
        // 注入,而非工具参数,且需服务端确实支持 OBO + type-17。
        const clientMsgNo = generateClientMsgNo();
        const result = await sendCardMessage({
          apiUrl,
          botToken,
          channelId: target.channelId,
          channelType: target.channelType as ChannelType,
          card,
          plain,
          clientMsgNo,
          // postJson 无默认超时 —— 显式设超时,避免挂起的 POST 无限期占住这次 tool 调用。
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });

        const messageId = result?.message_id ?? "";
        await recordDisplayCardRequest({
          ts: new Date().toISOString(),
          tool: DISPLAY_CARD_TOOL_NAME,
          tool_call_id: _toolCallId,
          account_id: requestedAccountId,
          channel_id: target.channelId,
          channel_type: target.channelType,
          thread_id: deliveryContext.threadId,
          client_msg_no: clientMsgNo,
          message_id: messageId,
          manifest: manifestForDebug(manifest),
          args: redactDebugValue({
            title: rawTitle,
            blocks: validated,
          }),
          rendered: redactDebugValue({ plain, card }),
        });
        return ok(
          `sent display card message_id=${messageId} channel=${target.channelId} elements=${body.length}`,
          { message_id: messageId, channel_id: target.channelId, client_msg_no: clientMsgNo },
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [tool];
}
