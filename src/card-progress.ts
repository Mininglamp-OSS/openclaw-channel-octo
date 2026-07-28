/**
 * 波 B —— InteractiveCard(=17) 进度卡状态机 + hook 驱动 + 节流。
 *
 * 架构(见 .context 计划):
 *   - dispatch(`inbound.ts`)在 run 开始 `setCardContext(sessionKey, ctx)` 存发送上下文
 *     (apiUrl/botToken/channel/onBehalfOf),`finally` 里 `finalizeCard(sessionKey, success)`。
 *   - 本模块订阅 hook(before/after_tool_call、model_call_started),用 `ctx.sessionKey`
 *     查 Map:首个工具事件懒发占位卡 → 后续就地 `editCardMessage`,节流合帧。
 *   - sessions_yield 将已发出的卡移入 pausedCards；后续 lifecycle run 继续编辑同一张卡。
 *   - `sessionKey` 桥接 dispatch 与 hook(H1 实证一致)。Map 只含 octo dispatch 登记的
 *     session → hook 查不到即 return,**天然过滤**非 octo run,无需 messageProvider 判断。
 *
 * 决策:关联键 sessionKey;单写者(dispatch per-group 串行)→ 不传 card_seq;卡仅进度/
 * 状态(C2,答案走文本);OBO(persona-clone)场景跳过(服务端拒 type-17 OBO,Decision 2b)。
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ChannelType, CARD_PROFILE, CARD_VERSION } from "./types.js";
import {
  editCardMessage,
  editTemplateCardMessage,
  getCardProfile,
  httpStatusFromApiFetchError,
  sendCardMessage,
  sendTemplateCardMessage,
  type CardProfileManifest,
  type CardTemplateRef,
} from "./api-fetch.js";
import { deriveCardCaps } from "./card-caps.js";
import { renderProgressCard, renderProgressResponseCard, summarizeToolParams, SUBAGENT_WAIT_STEP_TOOL, type CardStep, type CardProgressState, type CardCaps } from "./card-render.js";
import {
  buildReasoningProcessId,
  buildReasoningProcessWireData,
  renderReasoningProcessCard,
  selectReasoningProcessTemplate,
  summarizeToolResult,
} from "./reasoning-process.js";
import { DISPLAY_CARD_TOOL_NAME, INTERACTIVE_CARD_TOOL_NAME } from "./constants.js";
import type { ReasoningCardTemplateMode } from "./config-schema.js";

/** dispatch 侧登记的发送上下文。 */
export interface CardContext {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  /** false force-disables automatic progress cards for this account/session. */
  cardProgress?: boolean;
  /** Explicit Registry migration gate. Defaults to off (local Model B). */
  reasoningCardTemplateMode?: ReasoningCardTemplateMode;
  /** persona-clone 身份;存在则跳过卡片(服务端拒 type-17 OBO)。 */
  onBehalfOf?: string;
  /** OpenClaw reasoning visibility resolved for this turn/session. */
  reasoningVisibility?: "off" | "on" | "stream";
}

interface CardEntry {
  ctx: CardContext;
  /**
   * 发送目标身份指纹 = `apiUrl\0channelId\0onBehalfOf`。hook ctx 只带 sessionKey、
   * 不带 accountId,无法区分账号;仓库已文档化两个 bot 账号可能共享同一 sessionKey
   * (见 inbound.ts 的 sessionAccountMap 复合键)。setCardContext 用它检测跨身份碰撞,
   * 命中则 fail closed,避免把进度卡发到错误频道。
   */
  identity: string;
  /**
   * 属主 run 的 SDK runId。由 before_agent_run 在任何 model/tool 事件前预绑定;普通 hook
   * 只能校验、不能认领,避免旧 run 的迟到 hook first-hook-wins 抢占新 entry。
   */
  runId?: string;
  /** 调用 sessions_yield 后结束、正在等待后续 continuation 的 run。 */
  pausedFromRunId?: string;
  /** paused 后在同一 session 上启动的 continuation run。 */
  continuationRunId?: string;
  /** 当前 run 成功创建、可用于识别受信 completion prompt 的子 session。 */
  childSessionKeys: Set<string>;
  messageId?: string;
  phase: CardProgressState["phase"];
  steps: CardStep[];
  startedAt: number;
  dirty: boolean;
  inFlight: boolean;
  skip: boolean;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** 当前 in-flight flush 的 promise;finalizeCard 据此等待首帧 send/中间帧 edit 落定。 */
  flushPromise?: Promise<void>;
  /** paused/resuming/done 跨-run edit 的串行尾指针。 */
  stateEditPromise?: Promise<void>;
  stateEditAbort?: AbortController;
  /** paused 卡的有界回收定时器。 */
  pausedExpiryTimer?: ReturnType<typeof setTimeout>;
  /** replacement/clear 时主动取消 profile/send/edit,缩小 stale side-effect 窗口。 */
  flushAbort?: AbortController;
  /** Pinned once before the first send; one message must never switch wire modes. */
  deliveryMode?: "model-a" | "model-b";
  /** Manifest-selected ref, pinned for every frame of a Model A message. */
  templateRef?: CardTemplateRef;
  /** Next positive CAS value for a Model A edit. */
  nextCardSeq: number;
  /** Stable for every frame, including paused continuation runs. */
  reasoningId?: string;
}

type CachedCardProfile = {
  manifest: CardProfileManifest;
  expiresAt: number;
};

type CardProgressSharedState = {
  cards: Map<string, CardEntry>;
  pausedCards: Map<string, CardEntry>;
  profileCache: Map<string, CachedCardProfile>;
  capsCache: Map<string, CardCaps>;
};

/**
 * OpenClaw 分别加载 bundled channel 与 embedded agent runtime；两个加载实例必须共享
 * dispatch 登记的 entry 与 hook 更新状态。agent runtime 可拥有独立 global realm，因此
 * 状态挂在 Node process 对象而非 globalThis。版本放进 key，未来若结构不兼容可换 key。
 */
const CARD_PROGRESS_STATE_KEY = Symbol.for("openclaw.octo.card-progress-state.v1");

function getCardProgressSharedState(): CardProgressSharedState {
  const root = process as unknown as Record<PropertyKey, unknown>;
  const existing = root[CARD_PROGRESS_STATE_KEY] as CardProgressSharedState | undefined;
  if (existing) return existing;
  const created: CardProgressSharedState = {
    cards: new Map(),
    pausedCards: new Map(),
    profileCache: new Map(),
    capsCache: new Map(),
  };
  root[CARD_PROGRESS_STATE_KEY] = created;
  return created;
}

const sharedState = getCardProgressSharedState();

/** key = sessionKey(H1 实证:全 hook 一致)。跨账号碰撞由 entry.identity + fail-closed 兜底。 */
const cards = sharedState.cards;

/**
 * 已经结束当前 dispatch、但仍等待 continuation 的卡片。与 cards 分开保存，避免下一条
 * inbound 的 setCardContext 覆盖 messageId，导致后台任务回来后无法更新原卡。
 */
const pausedCards = sharedState.pausedCards;

/** Short-lived bot-scoped profile cache; expiry lets new messages observe catalog rollouts. */
const profileCache = sharedState.profileCache;

/**
 * D12 能力(elements/limits 派生的渲染 caps)缓存,key = apiUrl(部署级,同 gate)。gateEnabled
 * 探测 manifest 时一并填充;渲染时按元素以及节点/深度/字节上限裁剪。旧部署无这些字段 → caps 为空 → 渲染
 * 走保守默认(等同今天行为)。
 */
const capsCache = sharedState.capsCache;

const FLUSH_DEBOUNCE_MS = 800;
const EDIT_TIMEOUT_MS = 10_000;
const PROFILE_CACHE_TTL_MS = 60_000;
const REGISTRY_EDIT_RETRY_DELAYS_MS = [100, 250] as const;
/** Registry 契约里必须进修订历史的终态帧。 */
const TERMINAL_TEMPLATE_STATES = new Set(["completed", "stopped", "error"]);
const PAUSED_CARD_TTL_MS = 60 * 60 * 1000;
const INTERNAL_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_CONTEXT_NOTICE = "This context is runtime-generated, not user-authored. Keep internal details private.";

// 进度卡失败不影响主回复流程 —— 仅告警,不抛。
// eslint-disable-next-line no-console -- 波 B 进度卡诊断,失败降级不阻断主流程
const warn = (msg: string): void => console.warn(`[octo:card-progress] ${msg}`);
// eslint-disable-next-line no-console -- env-gated 端到端联调观测(OCTO_CARD_DEBUG),默认关
const dbg: (msg: string) => void = process.env.OCTO_CARD_DEBUG
  ? (msg) => console.log(`[octo:card-progress] ${msg}`)
  : () => {};

/**
 * 发送目标身份指纹。含 botToken —— 它才是账号的真正区分符:两个不同的非 OBO 账号即便
 * 同 apiUrl+同 channelId(都在同一群回复)也应视为不同身份、触发 fail-closed。仅在内存里
 * 做等值比较,不落日志。
 */
function contextIdentity(ctx: CardContext): string {
  return JSON.stringify([ctx.apiUrl, ctx.channelId, ctx.channelType, ctx.onBehalfOf ?? "", ctx.botToken]);
}

/** Profile enabled/catalog facts are authorized by botToken, not shared by an apiUrl deployment. */
function profileCacheKey(ctx: CardContext): string {
  return JSON.stringify([ctx.apiUrl, ctx.botToken]);
}

/**
 * dispatch run 开始时登记发送上下文。onBehalfOf 存在 → 标记跳过。
 *
 * 跨账号 fail-closed:若同 sessionKey 上已有**不同身份**的活跃 entry(两个 bot 账号
 * 共享了 sessionKey),hook 侧无法凭 sessionKey 区分账号,两边都置 skip —— 宁可都不发,
 * 也绝不把进度卡 send/edit 到错误频道。persona-clone/OBO 本就 skip,此处再兜住
 * non-OBO 跨账号碰撞,以及「OBO 克隆覆盖冻结同 key 上普通 bot 卡」的情形。
 */
export function setCardContext(sessionKey: string, ctx: CardContext): void {
  if (!sessionKey) return;
  const identity = contextIdentity(ctx);
  const existing = cards.get(sessionKey);
  const paused = pausedCards.get(sessionKey);
  const collision = [existing, paused].some((entry) => !!entry && entry.identity !== identity);
  // 任何 replacement 都清掉旧 entry 的 debounce timer。旧 entry 若已有 messageId,其
  // fire-and-forget finalize 仍可收尾;但定时中间帧不得跨 generation 泄漏到新 run。
  if (existing?.flushTimer) {
    clearTimeout(existing.flushTimer);
    existing.flushTimer = undefined;
  }
  existing?.flushAbort?.abort(new Error("card entry replaced"));
  if (collision) {
    if (existing) existing.skip = true;
    if (paused) releasePausedCard(sessionKey, paused, "cross-identity collision");
    warn(`sessionKey collision across identities; failing closed for session=${sessionKey}`);
  }
  cards.set(sessionKey, {
    ctx,
    identity,
    childSessionKeys: new Set(),
    phase: "thinking",
    steps: [],
    startedAt: Date.now(),
    dirty: false,
    inFlight: false,
    nextCardSeq: 1,
    // Account config is a per-session narrowing decision. Keep it out of the
    // bot-scoped profile cache and apiUrl-keyed deployment render-caps cache.
    skip: collision || !!ctx.onBehalfOf || ctx.cardProgress === false,
  });
  dbg(`context set session=${sessionKey} channel=${ctx.channelId} obo=${!!ctx.onBehalfOf} collision=${collision}`);
}

/**
 * 是否允许发卡:D12 manifest 优先,端点未部署(available:false)则回退 env 开关。
 * 返回值三态:`true`=启用,`false`=**明确禁用**(可永久 skip 本 session),
 * `null`=**瞬时探测失败**(5xx/网络,不缓存、不 skip,下次 flush 重探)。
 */
async function gateEnabled(ctx: CardContext, signal?: AbortSignal): Promise<boolean | null> {
  const cacheKey = profileCacheKey(ctx);
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return profileEnabledForContext(ctx, cached.manifest);
  if (cached) profileCache.delete(cacheKey);
  try {
    const m = await getCardProfile({ apiUrl: ctx.apiUrl, botToken: ctx.botToken, signal });
    // 能力清单是部署级事实(与 enabled 无关),探到就缓存供渲染裁剪。
    capsCache.set(ctx.apiUrl, deriveCardCaps(m));
    // Profile 来自带 botToken 的请求，其中 enabled/templating 都是 Bot 级事实。
    profileCache.set(cacheKey, {
      manifest: m,
      expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
    });
    return profileEnabledForContext(ctx, m);
  } catch (err: unknown) {
    // 瞬时失败(5xx/网络抖动)不缓存、不 skip —— 否则一次抖动会让该 apiUrl(缓存)或
    // 该 session(skip)的卡片进度永久关闭。返回 null,下次 flush(仍在 !messageId 期间)重探。
    warn(`card gate probe failed (not caching): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function profileEnabledForContext(ctx: CardContext, manifest: CardProfileManifest): boolean {
  let enabled = manifest.available
    ? manifest.enabled
    : process.env.OCTO_CARD_MESSAGE_ENABLED === "1";
  const registryCompatible = ctx.reasoningCardTemplateMode === "experimental" &&
    !!selectReasoningProcessTemplate(manifest.templating);
  // Model A 由 Registry 模板自己的 wire/views 契约协商，不依赖 Model B 的 Adaptive Card
  // profile/card_version/elements。仅在实际走 Model B 时应用下面的渲染兼容 gate。
  if (enabled && manifest.available && !registryCompatible) {
    if (Array.isArray(manifest.profiles) && manifest.profiles.length > 0 &&
        !manifest.profiles.includes(CARD_PROFILE)) {
      dbg(`gate: profile ${CARD_PROFILE} not advertised (${manifest.profiles.join(",")}) → disabled`);
      enabled = false;
    } else if (typeof manifest.card_version === "string" && manifest.card_version !== CARD_VERSION) {
      dbg(`gate: card_version ${manifest.card_version} != ${CARD_VERSION} → disabled`);
      enabled = false;
    } else if (Array.isArray(manifest.elements) && !manifest.elements.includes("TextBlock")) {
      // Model B 的所有安全降级最终都依赖 TextBlock。显式空数组或缺 TextBlock 是权威不支持。
      dbg("gate: TextBlock not advertised → disabled");
      enabled = false;
    }
  }
  return enabled;
}

function resolveEntryDeliveryMode(entry: CardEntry): void {
  if (entry.deliveryMode) return;
  const requested = entry.ctx.reasoningCardTemplateMode ?? "experimental";
  const templateRef = selectReasoningProcessTemplate(
    profileCache.get(profileCacheKey(entry.ctx))?.manifest.templating,
  );
  if (requested === "shadow") {
    dbg(`Registry shadow discovery compatible=${!!templateRef}`);
  }
  if (requested === "experimental" && templateRef) {
    entry.deliveryMode = "model-a";
    entry.templateRef = templateRef;
    dbg(`selected Registry reasoning template ${templateRef.id}@${templateRef.version}`);
    return;
  }
  entry.deliveryMode = "model-b";
}

function scheduleFlush(sessionKey: string, entry: CardEntry): void {
  entry.dirty = true;
  if (entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = undefined;
    void flush(sessionKey);
  }, FLUSH_DEBOUNCE_MS);
}

function entryProgressState(
  sessionKey: string,
  entry: CardEntry,
  phase: CardProgressState["phase"] = entry.phase,
  opts: { elapsedMs?: number; errorText?: string } = {},
): CardProgressState {
  const runId = entry.continuationRunId ?? entry.runId;
  entry.reasoningId ??= buildReasoningProcessId(sessionKey, runId);
  return {
    reasoningId: entry.reasoningId,
    phase,
    steps: entry.steps,
    ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
    ...(opts.errorText ? { errorText: opts.errorText } : {}),
  };
}

function usesReasoningProcessContract(entry: CardEntry): boolean {
  const reasoningVisible = entry.ctx.reasoningVisibility === "on" ||
    entry.ctx.reasoningVisibility === "stream";
  return reasoningVisible && entry.steps.some((step) => !!step.thought?.trim());
}

function renderEntryProgress(
  sessionKey: string,
  entry: CardEntry,
  state: CardProgressState,
): { card: Record<string, unknown>; plain: string } {
  const caps = capsCache.get(entry.ctx.apiUrl);
  return usesReasoningProcessContract(entry)
    ? renderReasoningProcessCard(state, caps)
    : renderProgressCard(state, caps);
}

function isRetryableRegistryEditError(error: unknown): boolean {
  const transportStatus = httpStatusFromApiFetchError(error);
  const message = error instanceof Error ? error.message : String(error);
  // 本地契约校验(validateTemplateFrame / 必填字段)在 fetch 之前抛,前缀 `octo: ` 且无 HTTP 状态。
  // 重试只会用完全相同的非法 body 再打一次,所以不可重试;状态缺失的 **传输** 失败
  // (网络/超时,消息形如 `Octo API ... failed`)仍按可重试处理。
  if (transportStatus === undefined && /^octo: /.test(message)) return false;
  const semanticStatus = Number(message.match(/"http_status"\s*:\s*(\d{3})/)?.[1]);
  return transportStatus === undefined || transportStatus === 429 || transportStatus >= 500 ||
    (Number.isFinite(semanticStatus) && semanticStatus >= 500);
}

async function waitForRegistryRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function editTemplateCardWithRetry(
  params: Parameters<typeof editTemplateCardMessage>[0],
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await editTemplateCardMessage(params);
      return;
    } catch (error) {
      const delay = REGISTRY_EDIT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || params.signal?.aborted || !isRetryableRegistryEditError(error)) throw error;
      await waitForRegistryRetry(delay, params.signal ?? new AbortController().signal);
    }
  }
}

async function editEntryProgress(params: {
  sessionKey: string;
  entry: CardEntry;
  state: CardProgressState;
  transient?: boolean;
  signal: AbortSignal;
}): Promise<boolean> {
  const { entry, state } = params;
  if (!entry.messageId) return false;
  if (entry.deliveryMode === "model-a") {
    const data = buildReasoningProcessWireData(state);
    if (!data || !entry.templateRef) return false;
    const cardSeq = entry.nextCardSeq;
    await editTemplateCardWithRetry({
      apiUrl: entry.ctx.apiUrl,
      botToken: entry.ctx.botToken,
      messageId: entry.messageId,
      channelId: entry.ctx.channelId,
      channelType: entry.ctx.channelType,
      templateRef: entry.templateRef,
      state: data.state,
      data,
      cardSeq,
      // 调用方意图 **与** 非终态双重约束。只看 state 会把 markCardPaused 的持久 paused 帧
      // (contractState 映射成 reasoning,却可能挂上 PAUSED_CARD_TTL_MS=1h)误标 transient;
      // 只看调用方意图又会漏掉从 debounce flush 路径(恒 transient:true)到达的 stopped 终态。
      ...(params.transient && !TERMINAL_TEMPLATE_STATES.has(data.state)
        ? { transient: true }
        : {}),
      signal: params.signal,
    });
    entry.nextCardSeq = cardSeq + 1;
    return true;
  }

  const { card, plain } = renderEntryProgress(params.sessionKey, entry, state);
  if (!Array.isArray(card.body) || card.body.length === 0) return false;
  await editCardMessage({
    apiUrl: entry.ctx.apiUrl,
    botToken: entry.ctx.botToken,
    messageId: entry.messageId,
    channelId: entry.ctx.channelId,
    channelType: entry.ctx.channelType,
    card,
    plain,
    ...(params.transient ? { transient: true } : {}),
    ...(entry.ctx.onBehalfOf ? { onBehalfOf: entry.ctx.onBehalfOf } : {}),
    signal: params.signal,
  });
  return true;
}

async function flush(sessionKey: string): Promise<void> {
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip) return;
  // 已有 flush 在执行 → 直接返回。不在这里补排:执行中的那次会在 finally 里按 dirty 重排,
  // 且**不**覆盖 entry.flushPromise(否则 finalizeCard await 到的会是这次空转、而非真实 send)。
  if (entry.inFlight) return;
  if (!entry.dirty) return;

  // 置 inFlight 于任何 await **之前**:gate 探测/send 往返期间挡住并发 flush,否则首帧未落
  // messageId 前的 gate await 窗口里,新定时器可穿过检查并发起第二次 send(重复发卡)。
  entry.inFlight = true;
  const work = runFlush(sessionKey, entry);
  entry.flushPromise = work;
  try {
    await work;
  } finally {
    if (entry.flushPromise === work) entry.flushPromise = undefined;
  }
}

/** 实际执行 gate + send/edit。调用方已置 inFlight=true 并接管 flushPromise。 */
async function runFlush(sessionKey: string, entry: CardEntry): Promise<void> {
  const abort = new AbortController();
  entry.flushAbort = abort;
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(EDIT_TIMEOUT_MS)]);
  try {
    // 首帧前做一次 D12 gate。明确禁用 → 永久跳过本 session;瞬时失败 → 本轮不发,
    // 下次 flush(下个工具事件触发)重探,避免一次抖动永久关闭本 session。
    if (!entry.messageId) {
      const gate = await gateEnabled(entry.ctx, signal);
      // gate await 期间 entry 可能已被同 sessionKey 的下一 run 或跨身份上下文替换。
      // Map 对象身份就是 generation fence;stale entry 绝不能继续网络副作用。
      if (!isCurrentEntry(sessionKey, entry)) return;
      if (gate === false) {
        entry.skip = true;
        return;
      }
      if (gate === null) {
        // 瞬时探测失败:清 dirty 且不自动重排,避免端点故障期每 ~800ms 一次探测风暴。
        // 累积的 steps 仍在 entry 上,下个工具事件会重新 scheduleFlush 并重探。
        entry.dirty = false;
        return;
      }
      resolveEntryDeliveryMode(entry);
    }

    entry.dirty = false;
    const state = entryProgressState(sessionKey, entry);
    if (!entry.messageId) {
      if (!isCurrentEntry(sessionKey, entry)) return;
      let res;
      if (entry.deliveryMode === "model-a") {
        const data = buildReasoningProcessWireData(state);
        if (!data) {
          dbg("model-a first frame deferred: no phases with actions yet");
          return;
        }
        if (!entry.templateRef) return;
        res = await sendTemplateCardMessage({
          apiUrl: entry.ctx.apiUrl,
          botToken: entry.ctx.botToken,
          channelId: entry.ctx.channelId,
          channelType: entry.ctx.channelType,
          templateRef: entry.templateRef,
          state: data.state,
          data,
          signal,
        });
      } else {
        const { card, plain } = renderEntryProgress(sessionKey, entry, state);
        if (!Array.isArray(card.body) || card.body.length === 0) {
          warn("rendered card cannot fit negotiated capabilities/limits; disabling for session");
          entry.skip = true;
          return;
        }
        res = await sendCardMessage({
          apiUrl: entry.ctx.apiUrl,
          botToken: entry.ctx.botToken,
          channelId: entry.ctx.channelId,
          channelType: entry.ctx.channelType,
          card,
          plain,
          ...(entry.ctx.onBehalfOf ? { onBehalfOf: entry.ctx.onBehalfOf } : {}),
          signal,
        });
      }
      entry.messageId = res?.message_id;
      if (!isCurrentEntry(sessionKey, entry)) return;
      if (!entry.messageId) {
        warn("placeholder card send returned no message_id; disabling for session");
        entry.skip = true;
        return;
      }
      dbg(`placeholder sent messageId=${entry.messageId} steps=${entry.steps.length}`);
    } else {
      if (!isCurrentEntry(sessionKey, entry)) return;
      await editEntryProgress({
        sessionKey,
        entry,
        state,
        transient: true,
        signal,
      });
      if (!isCurrentEntry(sessionKey, entry)) return;
      dbg(`edited steps=${entry.steps.length} phase=${entry.phase}`);
    }
  } catch (err: unknown) {
    warn(`flush failed: ${err instanceof Error ? err.message : String(err)}`);
    // 确定性拒绝(4xx,除可重试的 429)→ fail-closed,别对着必然失败的 server 逐事件重试。
    // 5xx / 网络 / 429 保持可重试(与 gate 的瞬时失败处理一致)。
    const status = httpStatusFromApiFetchError(err);
    if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
      entry.skip = true;
    }
  } finally {
    if (entry.flushAbort === abort) entry.flushAbort = undefined;
    entry.inFlight = false;
    // 期间有新帧 → 再刷。entry 已被 finalize/clear 删除时不再重排,避免悬挂定时器。
    if (entry.dirty && !entry.skip && cards.get(sessionKey) === entry) scheduleFlush(sessionKey, entry);
  }
}

/** entry 是否仍是该 session 的当前 generation 且允许副作用。 */
function isCurrentEntry(sessionKey: string, entry: CardEntry): boolean {
  return cards.get(sessionKey) === entry && !entry.skip;
}

function isTrackedEntry(sessionKey: string, entry: CardEntry): boolean {
  return (cards.get(sessionKey) === entry || pausedCards.get(sessionKey) === entry) && !entry.skip;
}

function releasePausedCard(sessionKey: string, entry: CardEntry, reason: string): void {
  if (entry.pausedExpiryTimer) {
    clearTimeout(entry.pausedExpiryTimer);
    entry.pausedExpiryTimer = undefined;
  }
  entry.stateEditAbort?.abort(new Error(`paused card released: ${reason}`));
  entry.stateEditAbort = undefined;
  entry.skip = true;
  if (cards.get(sessionKey) === entry) cards.delete(sessionKey);
  if (pausedCards.get(sessionKey) === entry) pausedCards.delete(sessionKey);
}

function schedulePausedCardExpiry(sessionKey: string, entry: CardEntry): void {
  if (entry.pausedExpiryTimer) clearTimeout(entry.pausedExpiryTimer);
  entry.pausedExpiryTimer = setTimeout(() => {
    entry.pausedExpiryTimer = undefined;
    if (pausedCards.get(sessionKey) !== entry || entry.skip) return;
    void (async () => {
      await editTrackedCardState(sessionKey, entry, "expired");
      releasePausedCard(sessionKey, entry, "ttl expired");
    })();
  }, PAUSED_CARD_TTL_MS);
}

function startSubagentWait(entry: CardEntry, now: number): void {
  const last = entry.steps[entry.steps.length - 1];
  if (last?.tool === SUBAGENT_WAIT_STEP_TOOL && last.status === "running") return;
  entry.steps.push({ tool: SUBAGENT_WAIT_STEP_TOOL, status: "running", startedAt: now });
}

function endSubagentWait(entry: CardEntry, now: number): void {
  for (let i = entry.steps.length - 1; i >= 0; i--) {
    const step = entry.steps[i];
    if (step.tool !== SUBAGENT_WAIT_STEP_TOOL || step.status !== "running") continue;
    step.status = "done";
    step.durationMs = Math.max(0, now - (step.startedAt ?? now));
    return;
  }
}

/** 直接编辑一张已存在的进度卡；用于 paused continuation 的跨-run状态迁移。 */
async function editTrackedCardState(
  sessionKey: string,
  entry: CardEntry,
  phase: CardProgressState["phase"],
  opts: { transient?: boolean; errorText?: string } = {},
): Promise<void> {
  const previous = entry.stateEditPromise;
  const work = (async () => {
    if (previous) {
      try { await previous; } catch { /* previous transition already logged */ }
    }
    if (entry.flushPromise) {
      try { await entry.flushPromise; } catch { /* flush already logged */ }
    }
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = undefined;
    }
    if (!isTrackedEntry(sessionKey, entry) || !entry.messageId) return;

    const now = Date.now();
    endRunningThinking(entry, now);
    if (phase !== "paused") endSubagentWait(entry, now);
    entry.phase = phase;
    const state = entryProgressState(sessionKey, entry, phase, {
      elapsedMs: Date.now() - entry.startedAt,
      ...(opts.errorText ? { errorText: opts.errorText } : {}),
    });
    const abort = new AbortController();
    entry.stateEditAbort = abort;
    try {
      await editEntryProgress({
        sessionKey,
        entry,
        state,
        ...(opts.transient ? { transient: true } : {}),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(EDIT_TIMEOUT_MS)]),
      });
      dbg(`transitioned session=${sessionKey} phase=${phase}`);
    } catch (err: unknown) {
      if (entry.deliveryMode === "model-a") entry.skip = true;
      if (!abort.signal.aborted) {
        warn(`state transition failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (entry.stateEditAbort === abort) entry.stateEditAbort = undefined;
    }
  })();
  entry.stateEditPromise = work;
  try {
    await work;
  } finally {
    if (entry.stateEditPromise === work) entry.stateEditPromise = undefined;
  }
}

function finishPausedCard(
  sessionKey: string,
  entry: CardEntry,
  phase: "done" | "error",
  errorText?: string,
): Promise<void> {
  return (async () => {
    await editTrackedCardState(sessionKey, entry, phase, errorText ? { errorText } : {});
    releasePausedCard(sessionKey, entry, `continuation ${phase}`);
  })();
}

/** sessions_yield 的 lifecycle 元数据在旧 host/Codex lane 可能缺失；成功工具结果作为兼容兜底。 */
function markCardPaused(sessionKey: string, runId?: string, expectedEntry?: CardEntry): void {
  const entry = expectedEntry ?? cards.get(sessionKey) ?? pausedCards.get(sessionKey);
  if (!entry || entry.skip) return;
  if (runId && entry.runId &&
      entry.runId !== runId && entry.pausedFromRunId !== runId && entry.continuationRunId !== runId) return;
  const now = Date.now();
  endRunningThinking(entry, now);
  startSubagentWait(entry, now);
  entry.pausedFromRunId = runId ?? entry.continuationRunId ?? entry.runId;
  entry.continuationRunId = undefined;
  entry.phase = "paused";
  if (cards.get(sessionKey) === entry) {
    scheduleFlush(sessionKey, entry);
  } else {
    schedulePausedCardExpiry(sessionKey, entry);
    void editTrackedCardState(sessionKey, entry, "paused");
  }
}

/**
 * dispatch `finally` 收尾:完成/失败时清理；yield 时保留原卡供 continuation 更新。
 * 幂等:未登记或没发过占位卡则仅清理。
 */
export async function finalizeCard(
  sessionKey: string,
  opts: { success: boolean; errorText?: string } = { success: true },
): Promise<void> {
  const entry = cards.get(sessionKey);
  if (!entry) return;
  // 等待 in-flight flush 落定后再接管。否则:首帧 send 尚未 return 时 messageId 未就绪,
  // 直接删 entry 会跳过终态帧,占位卡「正在处理…」永久冻结;若有 in-flight 中间帧
  // (transient)edit,还可能后于终态帧落库、把「✅ 已完成」覆盖回「正在处理」。await 后
  // messageId 必已就绪、edit 顺序也串好。flush 内部已 catch+告警,这里吞掉即可。
  if (entry.flushPromise) {
    try { await entry.flushPromise; } catch { /* flush 内部已告警 */ }
  }
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  // P1-g:若仍有 running thinking(agent 收尾时最后一次 model_call 之后未再调工具),
  // 用当前时间把它标 done + 算 duration —— 终态帧不留 ⏳。
  endRunningThinking(entry, Date.now());
  const retainForContinuation = entry.phase === "paused" || entry.phase === "resuming";
  // 只在 entry 仍是当前登记项时删除。finalize 是 fire-and-forget 且上面 await 了 in-flight
  // flush;await 期间 per-group 队列可能推进,同 sessionKey 的下一 run setCardContext 已把
  // Map 换成新 entry —— 那时删 key 会误删新 run 的状态,使其全程无卡。终态帧仍发本 run。
  if (cards.get(sessionKey) === entry) {
    cards.delete(sessionKey);
    // 没发出 messageId 的懒卡没有可更新对象，不能长期滞留在 pausedCards。
    if (retainForContinuation && !entry.skip && entry.messageId) {
      pausedCards.set(sessionKey, entry);
      schedulePausedCardExpiry(sessionKey, entry);
    }
  }

  // 从没发过卡(skip / 无工具调用)→ 无需收尾帧。
  if (entry.skip || !entry.messageId) return;

  if (retainForContinuation) {
    await editTrackedCardState(sessionKey, entry, entry.phase);
    return;
  }

  const terminalPhase: CardProgressState["phase"] = entry.phase === "stopped"
    ? "stopped"
    : opts.success ? "done" : "error";
  const state = entryProgressState(sessionKey, entry, terminalPhase, {
    elapsedMs: Date.now() - entry.startedAt,
    ...(opts.errorText ? { errorText: opts.errorText } : {}),
  });
  try {
    const edited = await editEntryProgress({
      sessionKey,
      entry,
      state,
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
    if (!edited) {
      warn("terminal card data is unavailable; leaving last valid frame");
      return;
    }
    dbg(`finalized session=${sessionKey} phase=${state.phase} steps=${entry.steps.length}`);
  } catch (err: unknown) {
    warn(`finalize failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Try to turn an already-visible progress card into the terminal response.
 * Returns false without consuming the entry when no card exists, rendering
 * exceeds negotiated limits, or the edit fails; callers can then send normal
 * text and let `finalizeCard` close the progress card separately.
 */
export async function finalizeCardWithResponse(
  sessionKey: string,
  responseText: string,
): Promise<boolean> {
  const entry = cards.get(sessionKey);
  if (!entry) return false;
  if (entry.flushPromise) {
    try { await entry.flushPromise; } catch { /* flush already logged */ }
  }
  if (entry.flushTimer) {
    clearTimeout(entry.flushTimer);
    entry.flushTimer = undefined;
  }
  endRunningThinking(entry, Date.now());
  if (entry.skip || !entry.messageId || cards.get(sessionKey) !== entry) return false;
  // Registry-authored messages can only be updated with template_ref + state + data.
  // The final answer remains on the normal text path for Model A.
  if (entry.deliveryMode === "model-a") return false;

  const rendered = renderProgressResponseCard({
    phase: "done",
    steps: entry.steps,
    elapsedMs: Date.now() - entry.startedAt,
  }, responseText, capsCache.get(entry.ctx.apiUrl));
  if (!rendered) return false;

  // Freeze late hook/debounce activity while the terminal edit is in flight so
  // no stale transient frame can overwrite the merged response afterward.
  entry.skip = true;
  try {
    await editCardMessage({
      apiUrl: entry.ctx.apiUrl,
      botToken: entry.ctx.botToken,
      messageId: entry.messageId,
      channelId: entry.ctx.channelId,
      channelType: entry.ctx.channelType,
      card: rendered.card,
      plain: rendered.plain,
      ...(entry.ctx.onBehalfOf ? { onBehalfOf: entry.ctx.onBehalfOf } : {}),
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
    if (cards.get(sessionKey) === entry) cards.delete(sessionKey);
    dbg(`merged final response session=${sessionKey} steps=${entry.steps.length}`);
    return true;
  } catch (err: unknown) {
    if (cards.get(sessionKey) === entry) entry.skip = false;
    warn(`final response merge failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 硬清理(不发收尾帧),用于异常兜底。 */
export function clearCard(sessionKey: string): void {
  const entry = cards.get(sessionKey);
  const paused = pausedCards.get(sessionKey);
  for (const tracked of new Set([entry, paused].filter((item): item is CardEntry => !!item))) {
    if (tracked.flushTimer) clearTimeout(tracked.flushTimer);
    if (tracked.pausedExpiryTimer) clearTimeout(tracked.pausedExpiryTimer);
    tracked.flushAbort?.abort(new Error("card entry cleared"));
    tracked.stateEditAbort?.abort(new Error("card entry cleared"));
    tracked.skip = true;
  }
  cards.delete(sessionKey);
  pausedCards.delete(sessionKey);
}

/** 测试辅助:清空全部状态。 */
export function _resetCardProgressForTests(): void {
  for (const e of new Set([...cards.values(), ...pausedCards.values()])) {
    if (e.flushTimer) clearTimeout(e.flushTimer);
    if (e.pausedExpiryTimer) clearTimeout(e.pausedExpiryTimer);
    e.flushAbort?.abort(new Error("card progress reset"));
    e.stateEditAbort?.abort(new Error("card progress reset"));
    e.skip = true;
  }
  cards.clear();
  pausedCards.clear();
  profileCache.clear();
  capsCache.clear();
}

/**
 * 注册 hook。经 `index.ts` registerFull 调用(仅 full mode)。
 * hook 全局触发,但仅处理 Map 中已登记(octo dispatch)的 sessionKey。
 */
/**
 * 关闭最后一步 running 的 thinking(若存在),用 now 算 durationMs。P1-g:SDK 无
 * model_call_ended,thinking 结束时机由外部信号(before_tool_call / finalize)驱动。
 */
function endRunningThinking(entry: CardEntry, now: number): void {
  const last = entry.steps[entry.steps.length - 1];
  if (!last || last.tool !== "__thinking__" || last.status !== "running") return;
  last.status = "done";
  if (typeof last.startedAt === "number") last.durationMs = Math.max(0, now - last.startedAt);
}

const MAX_REASONING_CAPTURE = 4_000;

/** Capture OpenClaw's user-visible reasoning lane without sending it as a normal message. */
export function recordCardReasoning(
  sessionKey: string,
  text: string,
  opts: { snapshot?: boolean } = {},
): void {
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip || !text) return;
  let thinking: CardStep | undefined;
  for (let index = entry.steps.length - 1; index >= 0; index--) {
    if (entry.steps[index]?.tool === "__thinking__") {
      thinking = entry.steps[index];
      break;
    }
  }
  if (!thinking) {
    thinking = { tool: "__thinking__", status: "running", startedAt: Date.now() };
    entry.steps.push(thinking);
  }
  const previous = thinking.thought ?? "";
  // OpenClaw harnesses do not all stamp snapshot metadata consistently. Treat
  // a repeated/full-prefix value as a snapshot so the agent-event lane and the
  // reply callback can coexist without duplicating the same reasoning text.
  const next = opts.snapshot || text === previous || text.startsWith(previous)
    ? text
    : `${previous}${text}`;
  thinking.thought = next.slice(0, MAX_REASONING_CAPTURE);
  if (entry.messageId || entry.steps.some((step) => step.tool !== "__thinking__")) {
    scheduleFlush(sessionKey, entry);
  }
}

/**
 * Bind dispatcher reasoning capture to the exact card-entry generation that created it.
 * A late callback from a timed-out turn cannot resolve by sessionKey into a replacement entry.
 */
export function createCardReasoningRecorder(sessionKey: string): (
  text: string,
  opts?: { snapshot?: boolean },
) => void {
  const generation = cards.get(sessionKey);
  return (text, opts = {}) => {
    if (!generation || cards.get(sessionKey) !== generation || generation.skip ||
        (generation.ctx.reasoningVisibility !== "on" && generation.ctx.reasoningVisibility !== "stream")) {
      return;
    }
    recordCardReasoning(sessionKey, text, opts);
  };
}

/** Best-effort answering transition inferred from the first non-reasoning reply payload. */
export function markCardAnswering(sessionKey: string): void {
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip || entry.phase === "stopped" || entry.phase === "error") return;
  endRunningThinking(entry, Date.now());
  entry.phase = "answering";
  if (entry.messageId) scheduleFlush(sessionKey, entry);
}

/**
 * runId 归属守卫。before_agent_run 是唯一绑定点;普通 hook 永不认领 entry。
 * 旧 host 完全不提供 runId 时保留 sessionKey-only 兼容;一旦 entry 已绑定 runId,
 * 缺失或不匹配 runId 的 hook 均 fail closed。
 */
function claimRun(entry: CardEntry, ctx: unknown): boolean {
  const rid = (ctx as { runId?: string })?.runId;
  if (!rid) return entry.runId === undefined;
  if (entry.runId === undefined) return false;
  return entry.runId === rid;
}

/**
 * 从可信 agent 生命周期 hook 预绑定 run owner。before_prompt_build 与 before_agent_run
 * 都早于 model/tool 事件;重复绑定相同 runId 幂等,不同 runId 不能覆盖已有 owner。
 */
export function bindCardRun(sessionKey: string | undefined, runId: string | undefined): void {
  if (!sessionKey || !runId) return;
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip) return;
  if (entry.runId === undefined) entry.runId = runId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 兼容新 host 的 result.details 与旧 host content[].text 中的 JSON 工具结果。 */
function acceptedSpawnChildSessionKey(result: unknown): string | undefined {
  const root = asRecord(result);
  if (!root) return undefined;
  const candidates: Record<string, unknown>[] = [root];
  const details = asRecord(root.details);
  if (details) candidates.push(details);
  if (Array.isArray(root.content)) {
    for (const item of root.content) {
      const text = asRecord(item)?.text;
      if (typeof text !== "string") continue;
      try {
        const parsed = asRecord(JSON.parse(text));
        if (!parsed) continue;
        candidates.push(parsed);
        const parsedDetails = asRecord(parsed.details);
        if (parsedDetails) candidates.push(parsedDetails);
      } catch {
        // 非 JSON 文本不是 sessions_spawn 的结构化结果。
      }
    }
  }
  for (const candidate of candidates) {
    const childSessionKey = typeof candidate.childSessionKey === "string"
      ? candidate.childSessionKey.trim()
      : "";
    if (candidate.status === "accepted" && childSessionKey) return childSessionKey;
  }
  return undefined;
}

/**
 * 仅信任 OpenClaw 生成的 protected internal-context completion event。用户文本中的
 * 同名字段不会命中：host 会转义用户提供的 BEGIN/END delimiter。
 */
function matchingCompletionChildSessionKey(prompt: unknown, expected: Set<string>): string | undefined {
  if (typeof prompt !== "string" || expected.size === 0) return undefined;
  const escapedBegin = INTERNAL_CONTEXT_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = INTERNAL_CONTEXT_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(
    `(?:^|\\r?\\n)${escapedBegin}\\r?\\n([\\s\\S]*?)\\r?\\n${escapedEnd}(?=\\r?\\n|$)`,
    "g",
  );
  for (const blockMatch of prompt.matchAll(blockPattern)) {
    const block = blockMatch[1] ?? "";
    if (!block.includes(INTERNAL_CONTEXT_NOTICE)) continue;
    const eventPattern = /(?:^|\r?\n)\[Internal task completion event\]\r?\nsource:\s*subagent\s*\r?\nsession_key:\s*([^\r\n]+)(?=\r?\n|$)/g;
    for (const eventMatch of block.matchAll(eventPattern)) {
      const childSessionKey = (eventMatch[1] ?? "").trim();
      if (expected.has(childSessionKey)) return childSessionKey;
    }
  }
  return undefined;
}

function bindPausedContinuation(
  sessionKey: string | undefined,
  runId: string | undefined,
  prompt: unknown,
): void {
  if (!sessionKey || !runId) return;
  const entry = pausedCards.get(sessionKey);
  if (!entry || entry.skip || !entry.pausedFromRunId || runId === entry.pausedFromRunId) return;
  if (entry.continuationRunId) return;
  const childSessionKey = matchingCompletionChildSessionKey(prompt, entry.childSessionKeys);
  if (!childSessionKey) return;
  endSubagentWait(entry, Date.now());
  entry.childSessionKeys.delete(childSessionKey);
  entry.continuationRunId = runId;
  void editTrackedCardState(sessionKey, entry, "resuming", { transient: true });
}

export function registerCardProgress(api: OpenClawPluginApi): void {
  registerCardReasoningSubscription(api);

  api.on("before_agent_run", (event: unknown, ctx: unknown) => {
    const { sessionKey, runId } = (ctx ?? {}) as { sessionKey?: string; runId?: string };
    bindCardRun(sessionKey, runId);
    bindPausedContinuation(sessionKey, runId, asRecord(event)?.prompt);
    // before_agent_run 是 fail-closed gate。必须显式 pass,不能依赖不同 host 对 void 的解释。
    return { outcome: "pass" } as const;
  });

  api.on("before_tool_call", (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as { toolName?: string; params?: unknown; toolCallId?: string };
    const sk = (ctx as { sessionKey?: string })?.sessionKey;
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip || !e.toolName) return;
    if (!claimRun(entry, ctx)) return; // 超时 run 的迟到 hook 落到新 run 的卡 → 丢弃
    // P1-h:agent 展示卡工具的产出**就是那张卡本身**,不该再有旁边的"正在处理/已中断"进度卡噪音。
    // 该工具不计入进度、不触发发卡。混合 turn 里其它真实工具照常显示,仅不含这步。
    if (e.toolName === DISPLAY_CARD_TOOL_NAME || e.toolName === INTERACTIVE_CARD_TOOL_NAME) {
      // 仍要收尾上一轮 running thinking —— 否则思考步 duration 会把 display-card 的执行时长吞进去。
      endRunningThinking(entry, Date.now());
      return;
    }
    dbg(`before_tool_call tool=${e.toolName} session=${sk}`);
    endRunningThinking(entry, Date.now()); // P1-g:上一轮 thinking 收尾
    entry.phase = "tool";
    entry.steps.push({
      tool: e.toolName,
      status: "running",
      summary: summarizeToolParams(e.toolName, e.params),
      ...(e.toolCallId ? { toolCallId: e.toolCallId } : {}),
    });
    scheduleFlush(sk!, entry);
  });

  // Intentionally do not register before_message_write for reasoning capture: that hook has no
  // runId, and neither FIFO model-end tokens nor sessionKey can prove ownership after a yield,
  // replacement, or dropped hook. Providers visible only through that lane fall back to generic
  // thought copy; privacy takes precedence over intermediate-text coverage.
  // OpenClaw 2026.6.9 may persist provider thinking even when the streaming agent
  // event lane emits nothing for a provider. llm_output exposes that persisted
  // assistant message together with runId, so a superseded run cannot write into
  // the current sessionKey generation.
  api.on("llm_output", (event: unknown, ctx: unknown) => {
    const root = asRecord(event);
    const sk = (ctx as { sessionKey?: string })?.sessionKey;
    const runId = typeof root?.runId === "string"
      ? root.runId
      : (ctx as { runId?: string })?.runId;
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip || !runId || !claimRun(entry, { runId }) ||
        (entry.ctx.reasoningVisibility !== "on" && entry.ctx.reasoningVisibility !== "stream")) {
      return;
    }
    const message = asRecord(root?.lastAssistant);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    const thought = message.content
      .map((part) => asRecord(part))
      .filter((part) => part?.type === "thinking" && typeof part.thinking === "string")
      .map((part) => part!.thinking as string)
      .join("\n")
      .trim();
    if (thought) recordCardReasoning(sk!, thought, { snapshot: true });
  });

  api.on("after_tool_call", (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as {
      toolName?: string;
      error?: string;
      durationMs?: number;
      toolCallId?: string;
      result?: unknown;
    };
    const sk = (ctx as { sessionKey?: string })?.sessionKey;
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip) return;
    if (!claimRun(entry, ctx)) return; // 同 §before_tool_call:外来 run 的迟到 after 事件 → 丢弃
    // P1-h:与 before_tool_call 对称,避免 display-card 触发 scheduleFlush 而误发进度卡。
    if (e.toolName === DISPLAY_CARD_TOOL_NAME || e.toolName === INTERACTIVE_CARD_TOOL_NAME) return;
    // 回填终态。优先按 toolCallId 精确匹配 running 步骤;若 toolCallId 存在但没命中
    // running(过期/重复投递的 after 事件),直接丢弃,**不**回退按名匹配 —— 否则会把仍
    // 在跑的并发同名步骤误标为终态。仅当 toolCallId 缺失(旧 host)才回退「最后一个同名 running」。
    let target: CardStep | undefined;
    if (e.toolCallId) {
      target = entry.steps.find((s) => s.toolCallId === e.toolCallId && s.status === "running");
    } else {
      for (let i = entry.steps.length - 1; i >= 0; i--) {
        const s = entry.steps[i];
        if (s.tool === e.toolName && s.status === "running") { target = s; break; }
      }
    }
    if (target) {
      target.status = e.error ? "error" : "done";
      if (typeof e.durationMs === "number") target.durationMs = e.durationMs;
      if (e.error) target.error = e.error;
      if (!e.error) target.resultSummary = summarizeToolResult(e.toolName, e.result);
    }
    if (e.toolName === "sessions_spawn" && !e.error) {
      const childSessionKey = acceptedSpawnChildSessionKey(e.result);
      if (childSessionKey) entry.childSessionKeys.add(childSessionKey);
    }
    if (e.toolName === "sessions_yield" && !e.error) {
      markCardPaused(sk!, (ctx as { runId?: string })?.runId);
    }
    scheduleFlush(sk!, entry);
  });

  api.on("model_call_started", (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as { callId?: string };
    const sk = (ctx as { sessionKey?: string })?.sessionKey;
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip) return;
    if (!claimRun(entry, ctx)) return; // 外来 run 的迟到 model_call → 丢弃
    // P1-g:每次 model_call 产一步"思考"。若上一步就是 running thinking(model_call_started
    // 被连续投递),忽略(去重)。
    const last = entry.steps[entry.steps.length - 1];
    if (last && last.tool === "__thinking__" && last.status === "running") return;
    // 首段思考(尚无真实工具步)→ header 显示"🤖 思考中…";真实工具跑过后保持"正在处理…"。
    const hadRealStep = entry.steps.some((s) => s.tool !== "__thinking__");
    if (!hadRealStep) entry.phase = "thinking";
    entry.steps.push({
      tool: "__thinking__",
      status: "running",
      startedAt: Date.now(),
      ...(e.callId ? { modelCallId: e.callId } : {}),
    });
    // 懒发契约(模块头:"首个工具事件懒发占位卡"):**纯思考不发首帧卡**。仅当卡已存在(messageId)
    // 或已有真实工具步时才刷新 —— 否则纯文本 / 纯 display-card turn 的思考步会误发一张占位卡,
    // 并在收尾时 finalize 成误导性的"⚠️ 已中断",正是 P1-h 想消除的噪音。
    if (entry.messageId || hadRealStep) scheduleFlush(sk!, entry);
  });

  api.on("model_call_ended", (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as {
      callId?: string;
      durationMs?: number;
      outcome?: "completed" | "error";
      failureKind?: string;
      errorCategory?: string;
    };
    const { sessionKey: sk } = (ctx ?? {}) as { sessionKey?: string };
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip || !claimRun(entry, ctx)) return;
    const target = e.callId
      ? entry.steps.find((step) => step.tool === "__thinking__" && step.modelCallId === e.callId)
      : undefined;
    if (target) {
      target.status = e.outcome === "error" ? "error" : "done";
      if (typeof e.durationMs === "number") target.durationMs = e.durationMs;
      if (e.outcome === "error") target.error = e.errorCategory ?? e.failureKind;
    }
    if (e.failureKind === "aborted") entry.phase = "stopped";
    if (entry.messageId) scheduleFlush(sk!, entry);
  });

  const hasLifecycleSubscription = registerCardLifecycleSubscription(api);
  api.on("agent_end", (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as { runId?: string; success?: boolean; error?: string };
    const { sessionKey, runId: contextRunId } = (ctx ?? {}) as { sessionKey?: string; runId?: string };
    const runId = e.runId ?? contextRunId;
    if (!sessionKey || !runId) return;
    if (hasLifecycleSubscription) return;
    const entry = pausedCards.get(sessionKey);
    if (!entry || entry.continuationRunId !== runId) return;
    return finishPausedCard(sessionKey, entry, e.success === true ? "done" : "error", e.error);
  });
}

type CardLifecycleEvent = {
  runId: string;
  sessionKey?: string;
  stream: string;
  data: Record<string, unknown>;
};

type CardLifecycleSubscription = {
  id: string;
  description?: string;
  streams?: string[];
  handle: (event: CardLifecycleEvent) => void | Promise<void>;
};

type CardAgentEventRegister = (subscription: CardLifecycleSubscription) => void;

function resolveCardAgentEventRegister(api: OpenClawPluginApi): CardAgentEventRegister | undefined {
  const compat = api as unknown as {
    agent?: {
      events?: {
        registerAgentEventSubscription?: CardAgentEventRegister;
      };
    };
    registerAgentEventSubscription?: CardAgentEventRegister;
  };
  const nested = compat.agent?.events?.registerAgentEventSubscription;
  if (nested) {
    return (subscription) => nested.call(compat.agent!.events, subscription);
  }
  const flat = compat.registerAgentEventSubscription;
  return flat ? (subscription) => flat.call(compat, subscription) : undefined;
}

function registerCardReasoningSubscription(api: OpenClawPluginApi): boolean {
  const register = resolveCardAgentEventRegister(api);
  if (!register) return false;
  register({
    id: "octo-card-progress-reasoning",
    description: "Capture OpenClaw thinking events for Octo progress cards",
    streams: ["thinking"],
    handle: (event) => {
      if (event.stream !== "thinking" || !event.sessionKey || !event.runId) return;
      const entry = cards.get(event.sessionKey);
      if (!entry || entry.skip ||
          (entry.ctx.reasoningVisibility !== "on" && entry.ctx.reasoningVisibility !== "stream") ||
          !claimRun(entry, { runId: event.runId })) {
        return;
      }
      const text = typeof event.data.text === "string"
        ? event.data.text
        : typeof event.data.delta === "string" ? event.data.delta : "";
      if (!text) return;
      recordCardReasoning(event.sessionKey, text, {
        snapshot: typeof event.data.text === "string",
      });
    },
  });
  return true;
}

/**
 * 2026.7.x 提供 nested agent.events facade；旧 SDK 没有该字段，因此运行时 feature-detect，
 * 并保留 flat API 兼容。旧 host 至少仍可通过成功的 sessions_yield tool hook 显示 paused。
 */
function registerCardLifecycleSubscription(api: OpenClawPluginApi): boolean {
  const register = resolveCardAgentEventRegister(api);
  if (!register) {
    dbg("agent lifecycle subscription API unavailable; using sessions_yield tool fallback");
    return false;
  }
  register({
    id: "octo-card-progress-lifecycle",
    description: "Keep yielded Octo progress cards in sync with continuation runs",
    streams: ["lifecycle"],
    handle: handleCardLifecycleEvent,
  });
  return true;
}

function findPausedFlowEntry(sessionKey: string, runId: string): CardEntry | undefined {
  const candidates = [pausedCards.get(sessionKey), cards.get(sessionKey)];
  return candidates.find((entry) => !!entry?.pausedFromRunId &&
    (entry.pausedFromRunId === runId || entry.continuationRunId === runId));
}

async function handleCardLifecycleEvent(event: CardLifecycleEvent): Promise<void> {
  if (event.stream !== "lifecycle" || !event.sessionKey || !event.runId) return;
  const phase = typeof event.data.phase === "string" ? event.data.phase : "";
  const sessionKey = event.sessionKey;

  // Error is authoritative even if a malformed/legacy event also carries yielded.
  if (phase === "error") {
    const entry = findPausedFlowEntry(sessionKey, event.runId);
    if (!entry) return;
    await finishPausedCard(
      sessionKey,
      entry,
      "error",
      typeof event.data.error === "string" ? event.data.error : undefined,
    );
    return;
  }

  if (phase === "end" && event.data.yielded === true) {
    const entry = findPausedFlowEntry(sessionKey, event.runId) ?? cards.get(sessionKey);
    if (entry?.runId === event.runId || entry?.continuationRunId === event.runId) {
      markCardPaused(sessionKey, event.runId, entry);
    }
    return;
  }

  // start 不含 parent/continuation 关联证据，不能据此认领 paused 卡。
  if (phase === "start") return;

  const entry = findPausedFlowEntry(sessionKey, event.runId);
  if (phase === "end" && entry?.continuationRunId === event.runId) {
    await finishPausedCard(sessionKey, entry, "done");
  }
}
