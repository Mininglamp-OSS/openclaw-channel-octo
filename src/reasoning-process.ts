import { createHash } from "node:crypto";
import { CARD_VERSION } from "./types.js";
import type { CardTemplateRef, CardTemplatingCapability } from "./api-fetch.js";
import { cardFitsLimits } from "./card-limits.js";
import {
  OCTO_CARD_LAYOUTS,
  SUBAGENT_WAIT_STEP_TOOL,
  cardSupports,
  fmtDuration,
  isSensitive,
  reduceUrlsInText,
  PROGRESS_CARD_PLACEHOLDER,
  renderProgressCard,
  sanitizeErrorText,
  type CardCaps,
  type CardProgressState,
  type CardStep,
} from "./card-render.js";

export type ReasoningProcessState = "reasoning" | "answering" | "completed" | "stopped" | "error";
export type ReasoningStatusTone = "Accent" | "Good" | "Warning" | "Attention";
export type ReasoningActionTone = "Accent" | "Good" | "Attention";

export interface ReasoningProcessAction {
  tool: string;
  detail: string;
  statusGlyph: string;
  statusTone: ReasoningActionTone;
}

export interface ReasoningProcessPhase {
  thought: string;
  actions: ReasoningProcessAction[];
}

/** Producer data shape for server-advertised ai.reasoning-process templates. */
export interface ReasoningProcessData {
  reasoningId: string;
  state: ReasoningProcessState;
  title: string;
  statusLabel: string;
  statusTone: ReasoningStatusTone;
  timerText: string;
  traceExpanded: boolean;
  traceCollapsed: boolean;
  collapsedSummary: string;
  progressText?: string;
  phases: ReasoningProcessPhase[];
  errorTitle?: string;
  errorMessage?: string;
}

/**
 * OpenClaw substitutes this exact sentence when a provider returns a *signed* reasoning block whose
 * text is empty — `extractAssistantThinking` in `embedded-agent-utils`, verified against OpenClaw
 * 2026.6.9. It is a host diagnostic, not prose meant for a channel-visible card.
 *
 * KNOWN FRAGILITY: recognising this state depends on matching a hardcoded English sentence in the
 * host. An OpenClaw upgrade that rewords it makes this check silently stop matching, and the state
 * degrades to `none` ("no reasoning content") — our own tests use our own constant and will NOT go
 * red. Re-check this string when upgrading OpenClaw. The durable fix belongs upstream: a structured
 * flag on the event rather than a sentence.
 */
export const HOST_NO_SUMMARY_PLACEHOLDER = "Native reasoning was produced; no summary text was returned.";

/**
 * The model demonstrably reasoned but returned no readable text. Reached via the host placeholder
 * above: OpenAI Responses when `summary: "auto"` yields nothing, and Anthropic `redacted_thinking`.
 */
const NO_SUMMARY_THOUGHT = "Reasoned without a visible summary";

/**
 * Our own guard withheld the text. Points at the redaction rules rather than at the content on
 * purpose: the guard is fail-safe, so a hit does not prove a credential was present — long hex,
 * git SHAs and other high-entropy strings trip it too. This is the only state that tells an
 * operator where to look, so it must stay distinguishable from NO_SUMMARY_THOUGHT.
 */
const REDACTED_THOUGHT = "Reasoning hidden — matched a redaction rule";

/**
 * 宿主内部上下文标记,容忍式匹配。固定子串挡不住把下划线换成别的字符(`INTERNAL~CONTEXT`)或
 * 在中间插入内容的变体 —— 这里只要求出现 `<<<`、BEGIN/END、OPENCLAW、INTERNAL 这几个片段,
 * 中间允许任意非字母数字的填充。宁可过度隐藏。
 */
const INTERNAL_CONTEXT_MARKER_RE =
  /<<<[^A-Za-z0-9]*(?:BEGIN|END)[^A-Za-z0-9]*OPENCLAW[^A-Za-z0-9]*INTERNAL/i;
/**
 * 一张卡上所有 phase 的 thought 加起来的上限(runes)。
 *
 * 逐字段 clamp 挡不住总量:trimForRender 允许 MAX_RENDERED_PHASES 个 phase,每个都有自己的
 * thought 预算(各由独立的 __thinking__ 步骤 + MAX_REASONING_CAPTURE 供给),所以 0.4.0 上
 * 最坏是 6 × 4001 ≈ 24K runes —— ASCII 约 24 KB、CJK 约 72 KB。
 *
 * 而模板发送路径**没有任何体积兜底**:本仓其他卡片生产者(card-blocks / card-author /
 * card-render)发送前都过 cardFitsLimits(它校验 maxPayloadBytes),而 sendTemplateCardMessage
 * 只调 validateTemplateFrame —— 只查形状,不查大小。仓库 fixture 里出现过 max_payload_bytes
 * 为 16384 的部署,24 KB 就已经越界。越界的代价不是内容变短,而是 400 → entry.skip → 整个
 * session 没有卡片。
 *
 * 6000 runes ≈ 18 KB CJK,留足余量;单 phase 仍可用满其版本上限,只有多个长 phase 同时出现时
 * 才开始裁剪。裁剪方向与 trimForRender 一致:**留最近的**,旧 phase 的思考先让位。
 */
const PHASES_THOUGHT_TOTAL_MAX = 6_000;

/**
 * 按总量裁剪 thought,从**最旧**的 phase 开始收缩。不删 phase(那会丢掉工具行 —— 读者没有
 * 别处可查),只把它的思考文本压短;压到 NO_THOUGHT_WIRE_LABEL 为止,因为契约要求 minLength 1。
 */
function budgetPhaseThoughts(
  phases: ReasoningProcessPhase[],
  total = PHASES_THOUGHT_TOTAL_MAX,
): ReasoningProcessPhase[] {
  const cost = (text: string): number => [...text].length;
  let used = phases.reduce((sum, phase) => sum + cost(phase.thought), 0);
  if (used <= total) return phases;
  const out = phases.map((phase) => ({ ...phase }));
  // 最旧的先收缩,最新的 phase 最后才被动到。
  for (let index = 0; index < out.length && used > total; index++) {
    const phase = out[index]!;
    const before = cost(phase.thought);
    // clampRunes 会追加一个 "…",产出是 keep + 1 —— 预算里要为它留位,否则每裁一个 phase
    // 就超 1 个 rune。
    const keep = before - (used - total) - 1;
    phase.thought = keep > 0 ? clampRunes(phase.thought, keep) : NO_THOUGHT_WIRE_LABEL;
    used -= before - cost(phase.thought);
  }
  return out;
}

/**
 * 其余字段的契约上限(0.2.0 起至 0.4.0 一致,0.4.0 只放开了 thought)。同样取自 handoff 产物。
 * 留一个字符给截断用的 "…"。
 */
const TIMER_TEXT_MAX = 128 - 1;
const ACTION_DETAIL_MAX = 192 - 1;
const ERROR_MESSAGE_MAX = 121 - 1;
const REASONING_ID_CONTRACT_MAX = 512;

/**
 * 按**码点**截断。契约的 maxLength 按 rune 计,而 JS slice 按 UTF-16 码元切 —— 后者会把代理对
 * 切断留下孤立代理(渲染成 �),码点计数也与契约不一致。
 */
function clampRunes(text: string, max: number): string {
  const runes = [...text];
  return runes.length > max ? runes.slice(0, max).join("") + "…" : text;
}

/**
 * `phases[].thought` 的 maxLength,按已发布模板版本。数字取自服务端 handoff 产物
 * `pkg/cardtmpl/ai_reasoning_process/handoff/ai.reasoning-process@<v>/contract/data.schema.json`
 * (0.4.0 见 octo-server#712)。
 *
 * 未列出的版本按 THOUGHT_CONTRACT_MAX_DEFAULT 处理 —— **保守方向**:新版本上线而这张表没更新时,
 * 卡片内容变短,但永不因超限被拒。超限的代价不是截断而是 400 → entry.skip → 整个 session 没有卡片,
 * 所以宁可少显示。0.4.0 的 schema 自己写明「producer 侧仍应自行截断到不超过此值」。
 */
const THOUGHT_CONTRACT_MAX_BY_VERSION: Readonly<Record<string, number>> = {
  "0.1.0": 281,
  "0.2.0": 281,
  "0.3.0": 281,
  "0.4.0": 4001,
};
const THOUGHT_CONTRACT_MAX_DEFAULT = 281;
const THOUGHT_CONTRACT_MAX_WIDEST = Math.max(
  ...Object.values(THOUGHT_CONTRACT_MAX_BY_VERSION),
  THOUGHT_CONTRACT_MAX_DEFAULT,
);

/** 该版本允许的思考文本渲染上限(留一个字符给截断用的 "…")。 */
function thoughtMaxForVersion(version: string | undefined): number {
  const contractMax = (version ? THOUGHT_CONTRACT_MAX_BY_VERSION[version] : undefined)
    ?? THOUGHT_CONTRACT_MAX_DEFAULT;
  return contractMax - 1;
}

/**
 * Per-phase ceiling used while sanitizing. This is the widest bound any published template version
 * allows minus one (the truncation appends "…"), NOT the bound that gets enforced — the template the
 * server actually selected decides that, and it is applied at the wire boundary by
 * `buildReasoningProcessWireData`. Keeping this generous means a deployment on a newer template is
 * not silently capped to an older version's bound.
 *
 * Why the wire boundary and not here: the selected `templateRef.version` is only known there.
 * Sanitizing is version-independent; conforming to a contract is not.
 *
 * Capture is separately bounded by MAX_REASONING_CAPTURE (4000) in card-progress.ts.
 */
const THOUGHT_MAX = THOUGHT_CONTRACT_MAX_WIDEST - 1;
const TOOL_NAME_MAX = 80;
const MAX_RENDERED_PHASES = 6;
const MAX_RENDERED_ACTIONS = 12;
const REASONING_TEMPLATE_ID = "ai.reasoning-process";
const TEMPLATE_WIRE = "template-ref/v1";
export const REASONING_ID_MAX_LENGTH = 512;

/** Preserve short IDs; use a stable collision-resistant digest instead of unsafe truncation. */
export function buildReasoningProcessId(sessionKey: string, runId?: string): string {
  const raw = runId ? `${sessionKey}:${runId}` : sessionKey;
  if ([...raw].length <= REASONING_ID_MAX_LENGTH) return raw;
  return `octo-reasoning:sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * Views this producer supplies data for. A template may omit controls, but every advertised
 * `submit_action` must be understood by this consumer; otherwise the server could render a button
 * that only gets ignored when clicked.
 */
const REQUIRED_VIEWS = [
  {
    name: "active",
    states: ["reasoning", "answering"],
    wireProfile: "octo/v2",
    submitActions: ["reasoning_stop"],
  },
  {
    name: "error",
    states: ["error"],
    wireProfile: "octo/v2",
    submitActions: ["reasoning_retry"],
  },
  { name: "result", states: ["completed", "stopped"], wireProfile: "octo/v1", submitActions: [] },
] as const;

/**
 * Select the sole Bot-catalog entry with the contract shape this producer implements.
 *
 * The server manifest is authoritative for the template version. Keeping a local version allowlist
 * would turn every compatible server rollout into a plugin release dependency, so a sole compatible
 * entry is returned with its advertised version unchanged. The template id plus wire/view/action
 * shape is the producer contract boundary; a breaking data contract must use a new id or negotiated
 * wire capability rather than relying on an unadvertised client-side version range.
 *
 * The authoritative cross-repo clauses are octo-server
 * `.octospec/tasks/cardtmpl-runtime-catalog-overlay/brief.md` D13/E1d and
 * `.octospec/tasks/cardtmpl-reasoning-schema-successor/brief.md` D5: the catalog advertises one
 * new-send version, and multiple compatible entries without an explicit preference capability
 * fail closed rather than reintroducing a local semver policy.
 * A duplicated id/version also remains ambiguous even if only one copy has compatible views:
 * `template_ref` cannot identify which copy the server would resolve.
 */
export function selectReasoningProcessTemplate(
  templating: CardTemplatingCapability | undefined,
  configuredRef?: CardTemplateRef | null,
): CardTemplateRef | null {
  if (!templating?.supported || templating.wire !== TEMPLATE_WIRE || configuredRef === null) return null;
  if (configuredRef !== undefined &&
      (configuredRef.id !== REASONING_TEMPLATE_ID || !configuredRef.version ||
       configuredRef.version.trim() !== configuredRef.version)) return null;
  const claimed = templating.templates.filter((template) =>
    template.id === REASONING_TEMPLATE_ID &&
    (configuredRef === undefined || template.version === configuredRef.version));
  const compatible = claimed.filter((template) => {
    if (!template.version || template.version.trim() !== template.version) return false;
    return REQUIRED_VIEWS.every((required) => {
      const matchingViews = template.views.filter((candidate) => candidate.name === required.name);
      if (matchingViews.length !== 1) return false;
      const view = matchingViews[0]!;
      if (view.wire_profile !== required.wireProfile) return false;
      const states = new Set(view.states);
      if (!required.states.every((state) => states.has(state))) return false;
      const allowedActions = new Set<string>(required.submitActions);
      return view.submit_actions.every((action) => allowedActions.has(action));
    });
  });
  if (compatible.length !== 1) return null;
  const match = compatible[0]!;
  if (claimed.filter((template) => template.version === match.version).length > 1) return null;
  return { id: match.id, version: match.version };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function candidateRecords(result: unknown): Record<string, unknown>[] {
  const root = asRecord(result);
  if (!root) return [];
  const records = [root];
  for (const key of ["details", "meta", "metadata", "summary"] as const) {
    const candidate = asRecord(root[key]);
    if (candidate) records.push(candidate);
  }
  return records;
}

/**
 * after_tool_call.result may contain whole files, command output, HTTP bodies, or credentials.
 * Only structural allowlisted fields are retained; arbitrary content text is never inspected.
 */
export function summarizeToolResult(toolName: string | undefined, result: unknown): string {
  if (result === undefined || result === null) return "";
  if (Array.isArray(result)) return `${result.length} results`;
  const records = candidateRecords(result);
  for (const record of records) {
    const exitCode = finiteCount(record.exitCode ?? record.exit_code ?? record.code);
    if (exitCode !== undefined && ["exec", "bash", "shell", "process"].includes(toolName ?? "")) {
      return `exit ${exitCode}`;
    }
  }
  for (const record of records) {
    const count = finiteCount(
      record.matchCount ?? record.match_count ?? record.resultCount ?? record.result_count ??
      record.totalCount ?? record.total_count,
    );
    if (count !== undefined) return `${count} results`;
  }
  for (const record of records) {
    const count = finiteCount(record.fileCount ?? record.file_count ?? record.changedFiles);
    if (count !== undefined) return `${count} files`;
    const bytes = finiteCount(record.bytes ?? record.byteLength ?? record.writtenBytes);
    if (bytes !== undefined) return `${bytes} bytes`;
  }
  for (const record of records) {
    const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
    if (["accepted", "queued", "waiting"].includes(status)) return status;
    if (["completed", "complete", "success", "succeeded", "ok", "done"].includes(status)) {
      return "completed";
    }
  }
  return "completed";
}

/**
 * Why a thought line reads the way it does. These four used to collapse into one string, so a
 * reader could not tell "the model did not reason" from "we withheld what it said" — and the second
 * is the only one that points at something an operator can act on.
 */
export type ReasoningThoughtKind = "text" | "none" | "no-summary" | "redacted";

export interface ReasoningThought {
  kind: ReasoningThoughtKind;
  /** Display string; empty for `none`, where no thought line is rendered at all. */
  text: string;
}

/** Reasoning lane text is visible to channel members, so fail closed on protected/secret shapes. */
export function resolveReasoningThought(text: string | undefined): ReasoningThought {
  if (!text) return { kind: "none", text: "" };
  let normalized = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Whitespace-only input carries no reasoning; it is not something we withheld.
  if (!normalized) return { kind: "none", text: "" };
  // 内部上下文标记:宿主用它包裹运行时生成的私有上下文,一旦渲染就是把内部信息发到群里。
  //
  // 三件事共同决定了这里的写法:
  //  1. **必须在剥离占位句之前查一次** —— 剥离会把拼进标记内部的占位句去掉,让标记散开、
  //     固定子串匹配不上(评审实测的 C 形态)。
  //  2. **剥离之后要再查一次** —— 占位句可以插在两处,一次剥离后标记仍是断的,但第二次
  //     检查能看到拼合后的结果(D 形态)。
  //  3. **容忍式正则而非固定子串** —— `INTERNAL~CONTEXT` 这类把下划线换成别的字符的变体,
  //     固定子串一个都抓不到(E/F 形态)。
  //
  // 这一类整体在 merge-base 上就存在(评审在 c81df55 上复现了 C/D/E),这里是收窄而非引入。
  // 可达性窄(需要模型输出被这样构造,即 prompt injection),但改的成本为零。
  if (INTERNAL_CONTEXT_MARKER_RE.test(normalized)) {
    return { kind: "redacted", text: REDACTED_THOUGHT };
  }
  // 包含式而非全等:recordCardReasoning 在非 snapshot 时会拼接(`previous + text`),而一个
  // `__thinking__` 步骤可能收到两次 model call 的文本(有些 host 从不投递 model_call_ended)。
  // 一旦占位句和别的文本相邻,全等就失效,值会被判成 `text`,把宿主的诊断句原样渲染到群卡上 ——
  // 正是 brief 列为非目标的那个结果。剥掉占位句后若还有真实文本,那才是要展示的内容。
  if (normalized.includes(HOST_NO_SUMMARY_PLACEHOLDER)) {
    const rest = normalized.split(HOST_NO_SUMMARY_PLACEHOLDER).join(" ").replace(/\s+/g, " ").trim();
    if (!rest) return { kind: "no-summary", text: NO_SUMMARY_THOUGHT };
    // 剥离可能让原本散开的标记拼合上 —— 再查一次。
    if (INTERNAL_CONTEXT_MARKER_RE.test(rest)) {
      return { kind: "redacted", text: REDACTED_THOUGHT };
    }
    normalized = rest;
  }
  normalized = reduceUrlsInText(normalized).replace(/\s+/g, " ").trim();
  // Empty after URL reduction means the whole thought was a URL we downgraded away: withheld, not
  // absent, so it stays distinguishable from `none`.
  if (!normalized || isSensitive(normalized, true)) {
    return { kind: "redacted", text: REDACTED_THOUGHT };
  }
  return {
    kind: "text",
    text: normalized.length > THOUGHT_MAX ? normalized.slice(0, THOUGHT_MAX) + "…" : normalized,
  };
}

/** Display string for a captured thought. See resolveReasoningThought for the classification. */
export function sanitizeReasoningThought(text: string | undefined): string {
  return resolveReasoningThought(text).text;
}

/**
 * Sanitizing one thought costs several regex passes over up to MAX_REASONING_CAPTURE chars, and
 * every debounce flush re-derives phases from the whole run. Steps are append-only and a thought
 * only mutates while its model call streams, so cache per step and re-sanitize on change. Keyed by
 * the step object, so entries die with the card entry.
 */
const sanitizedThoughts = new WeakMap<CardStep, { raw: string; resolved: ReasoningThought }>();

function cachedThought(step: CardStep): string {
  const raw = step.thought ?? "";
  const cached = sanitizedThoughts.get(step);
  if (cached && cached.raw === raw) return cached.resolved.text;
  const resolved = resolveReasoningThought(step.thought);
  sanitizedThoughts.set(step, { raw, resolved });
  return resolved.text;
}

function safeToolName(tool: string): string {
  if (tool === "__thinking__") return "think";
  if (tool === SUBAGENT_WAIT_STEP_TOOL) return "wait";
  const reduced = reduceUrlsInText(tool).replace(/\s+/g, " ").trim();
  if (!reduced || isSensitive(reduced, true)) return "tool";
  return reduced.length > TOOL_NAME_MAX ? reduced.slice(0, TOOL_NAME_MAX) + "…" : reduced;
}

function actionDetail(step: CardStep): string {
  if (step.tool === SUBAGENT_WAIT_STEP_TOOL) {
    const label = step.status === "running" ? "Waiting for subtask…" : "Subtask returned";
    const duration = fmtDuration(step.durationMs);
    return duration ? `${label} · ${duration}` : label;
  }
  const error = sanitizeErrorText(step.error);
  const parts = [step.summary, step.status === "error" ? error : step.resultSummary]
    .filter((value): value is string => !!value);
  if (parts.length > 0) return parts.join(" · ");
  if (step.status === "running") return "Running…";
  if (step.status === "error") return "Call failed";
  return "Completed";
}

function actionFromStep(step: CardStep): ReasoningProcessAction {
  return {
    tool: safeToolName(step.tool),
    detail: actionDetail(step),
    statusGlyph: "●",
    statusTone: step.status === "running" ? "Accent" : step.status === "error" ? "Attention" : "Good",
  };
}

function phasesFromSteps(
  steps: CardStep[],
  opts: { synthesizeEmptyActions?: boolean } = { synthesizeEmptyActions: true },
): ReasoningProcessPhase[] {
  const phases: ReasoningProcessPhase[] = [];
  let current: ReasoningProcessPhase | undefined;
  for (const step of steps) {
    if (step.tool === "__thinking__") {
      current = {
        thought: cachedThought(step),
        actions: [],
      };
      phases.push(current);
      continue;
    }
    if (!current) {
      // Actions with no preceding model call: structural, not a reasoning state. An empty thought
      // renders no thought line rather than implying a thought we never had.
      current = { thought: "", actions: [] };
      phases.push(current);
    }
    current.actions.push(actionFromStep(step));
  }
  // No steps at all. Note this phase has no actions, so buildReasoningProcessWireData filters it
  // out regardless — it is not what keeps the Model A first frame from being deferred.
  if (phases.length === 0) phases.push({ thought: "", actions: [] });
  if (opts.synthesizeEmptyActions === false) return phases;
  const thinkingSteps = steps.filter((step) => step.tool === "__thinking__");
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!;
    if (phase.actions.length > 0) continue;
    const thinking = thinkingSteps[index];
    const duration = fmtDuration(thinking?.durationMs);
    const detail = thinking?.status === "running" ? "Planning next step…"
      : thinking?.status === "error" ? "Phase stopped"
        : "Phase complete";
    phase.actions.push({
      tool: "think",
      detail: duration ? `${detail} · ${duration}` : detail,
      statusGlyph: "●",
      statusTone: thinking?.status === "running" ? "Accent"
        : thinking?.status === "error" ? "Attention"
          : "Good",
    });
  }
  return phases;
}

function phaseCount(n: number): string {
  return `${n} ${n === 1 ? "phase" : "phases"}`;
}

function toolCallCount(n: number): string {
  return `${n} ${n === 1 ? "tool call" : "tool calls"}`;
}

function contractState(phase: CardProgressState["phase"]): ReasoningProcessState {
  if (phase === "answering") return "answering";
  if (phase === "done") return "completed";
  if (phase === "stopped") return "stopped";
  if (phase === "error" || phase === "expired") return "error";
  return "reasoning";
}

export function buildReasoningProcessData(state: CardProgressState): ReasoningProcessData {
  return buildReasoningProcessDataWithPhases(state, phasesFromSteps(state.steps));
}

function buildReasoningProcessDataWithPhases(
  state: CardProgressState,
  phases: ReasoningProcessPhase[],
): ReasoningProcessData {
  const mapped = contractState(state.phase);
  const elapsed = fmtDuration(state.elapsedMs) || "0ms";
  const toolCount = state.steps.filter((step) =>
    step.tool !== "__thinking__" && step.tool !== SUBAGENT_WAIT_STEP_TOOL).length;
  const active = mapped === "reasoning" || mapped === "answering";
  // The failure reason must ride in an always-visible field. The error block lives inside the
  // collapsible trace, and for Model A the server template owns the layout — so hiding the trace
  // by default would bury the reason on both renderers unless the header carries it. This mirrors
  // renderProgressCard's header (`⚠️ Interrupted: <detail>` / `⏱️ Wait timed out`), including its
  // ERROR_MAX cap, which sanitizeErrorText already applies.
  const failureDetail = sanitizeErrorText(state.errorText);
  const failureLabel = state.phase === "expired" ? "Wait timed out" : "Interrupted";
  const errorMessage = failureDetail ||
    (state.phase === "expired"
      ? "Timed out waiting for the background task."
      : "Reasoning was interrupted. Completed steps were preserved.");
  const base: ReasoningProcessData = {
    reasoningId: state.reasoningId?.trim() || "octo-progress",
    state: mapped,
    title: "Reasoning",
    statusLabel: mapped === "reasoning" ? "Thinking"
      : mapped === "answering" ? "Answering"
        : mapped === "completed" ? "Done"
          : mapped === "stopped" ? "Stopped"
            : "Failed",
    statusTone: mapped === "reasoning" || mapped === "answering" ? "Accent"
      : mapped === "completed" ? "Good"
        : mapped === "stopped" ? "Warning"
          : "Attention",
    timerText: mapped === "reasoning" ? "Reasoning…"
      : mapped === "answering" ? "Writing the answer…"
        : mapped === "stopped" ? `${elapsed} · stopped at phase ${phases.length}`
          : mapped === "error" ? (failureDetail ? `${failureLabel} · ${failureDetail}` : failureLabel)
            : `${elapsed} · ${phaseCount(phases.length)} · ${toolCallCount(toolCount)}`,
    // Every terminal state collapses (done/stopped/error/expired), matching renderProgressCard:
    // a settled card is a summary, and collapsedSummary tells the reader to open it for the steps.
    // Only a running turn stays expanded.
    traceExpanded: active,
    traceCollapsed: !active,
    collapsedSummary: mapped === "answering" ? "Reasoning complete · answer in progress"
      : mapped === "stopped" ? `Kept ${phaseCount(phases.length)} from before the stop`
        : mapped === "error" ? `${failureLabel} · open to see the steps so far`
          : mapped === "completed" ? `${elapsed} · trace collapsed`
            : "Reasoning in progress · open to follow along",
    phases,
  };
  if (mapped === "reasoning") {
    base.progressText = state.phase === "paused" ? "Waiting for subtask…"
      : state.phase === "resuming" ? "Subtask returned. Wrapping up…"
        : "Working through…";
  } else if (mapped === "answering") {
    base.progressText = "Reasoning complete. Writing the answer…";
  } else if (mapped === "error") {
    base.errorTitle = "Generation failed";
    base.errorMessage = errorMessage;
  }
  return base;
}

function trimForRender(data: ReasoningProcessData): ReasoningProcessData {
  let remaining = MAX_RENDERED_ACTIONS;
  const visible: ReasoningProcessPhase[] = [];
  for (const phase of data.phases.slice(-MAX_RENDERED_PHASES).reverse()) {
    if (remaining <= 0) break;
    const actions = phase.actions.slice(-remaining);
    remaining -= actions.length;
    visible.push({ thought: phase.thought, actions });
  }
  return { ...data, phases: visible.reverse() };
}

/**
 * 「不渲染思考行」这件事在**数据契约里表达不出来**:template 的 `phases[].thought` 是
 * `required` 且 `minLength: 1`,空串会让服务端校验失败返回 400,而 4xx 会让 runFlush 置
 * `entry.skip = true` —— 整个 session 从此没有卡片。#204 之后模板路径是唯一出口,
 * renderReasoningProcessCard 已无生产调用方,所以契约违规不是降级渲染,而是功能整体消失。
 *
 * 因此 wire 侧对「没有可说的推理」用一句**简短的非空标签**,而不是空串。本地渲染器可以省掉
 * 整行(那是更好的呈现),但那个自由度只属于本地渲染。
 */
const NO_THOUGHT_WIRE_LABEL = "—";

/** Build bounded Registry data without inventing synthetic tool actions for empty model calls. */
export function buildReasoningProcessWireData(
  state: CardProgressState,
  templateVersion?: string,
): ReasoningProcessData | null {
  // 按**服务端选中的版本**收口。这是唯一知道版本的地方,也是唯一必须守契约的地方:超限是
  // 确定性 400,而 4xx 置 entry.skip —— 首帧被拒则整个 session 没有卡片,中途 edit 被拒则用户
  // 正在看的卡冻结在进行中、永远到不了终态。
  const thoughtMax = thoughtMaxForVersion(templateVersion);
  const phases = phasesFromSteps(state.steps, { synthesizeEmptyActions: false })
    .filter((phase) => phase.actions.length > 0)
    .map((phase) => ({
      // 空 thought 违反契约的 minLength:1 —— 见 NO_THOUGHT_WIRE_LABEL。
      thought: clampRunes(phase.thought || NO_THOUGHT_WIRE_LABEL, thoughtMax),
      // detail 此前完全没有长度上限,一个长工具摘要就能超过契约的 192。
      actions: phase.actions.map((action) => ({
        ...action,
        detail: clampRunes(action.detail, ACTION_DETAIL_MAX),
      })),
    }));
  if (phases.length === 0) return null;
  const data = trimForRender(buildReasoningProcessDataWithPhases(state, phases));
  // 逐字段 clamp 之后再收一次总量 —— trimForRender 决定了留几个 phase,总量只能在它之后算。
  data.phases = budgetPhaseThoughts(data.phases);
  // timerText 在失败轮次上会带上清洗后的错误详情,实测 error 135 / expired 138 runes,超过契约 128。
  return {
    ...data,
    timerText: clampRunes(data.timerText, TIMER_TEXT_MAX),
    // 这两个此前靠「另一个模块的常量刚好等于契约上限」成立,零余量:改动 ERROR_MAX 或
    // REASONING_ID_MAX_LENGTH 就会让错误态卡片 400 并消失。在这里 clamp,不再依赖那个巧合。
    ...(data.errorMessage === undefined ? {} : { errorMessage: clampRunes(data.errorMessage, ERROR_MESSAGE_MAX) }),
    reasoningId: clampRunes(data.reasoningId, REASONING_ID_CONTRACT_MAX),
  };
}

function textBlock(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "TextBlock", text, wrap: true, ...extra };
}

function actionRow(action: ReasoningProcessAction, first: boolean): Record<string, unknown> {
  return {
    type: "ColumnSet",
    spacing: first ? "None" : "Small",
    columns: [
      { type: "Column", width: "auto", items: [textBlock(action.statusGlyph, { color: action.statusTone, size: "Small", spacing: "None" })] },
      { type: "Column", width: "auto", items: [textBlock(action.tool, { weight: "Bolder", size: "Small", spacing: "None" })] },
      { type: "Column", width: "stretch", items: [textBlock(action.detail, { isSubtle: true, size: "Small", spacing: "None" })] },
    ],
  };
}

function phaseBlock(phase: ReasoningProcessPhase, first: boolean): Record<string, unknown> {
  return {
    type: "Container",
    spacing: first ? "None" : "Large",
    separator: !first,
    items: [
      // An empty thought means there is nothing to say about this phase's reasoning; render the
      // actions alone rather than an empty line.
      ...(phase.thought ? [textBlock(phase.thought, { size: "Small", spacing: "None" })] : []),
      {
        type: "Container",
        style: "emphasis",
        spacing: "Small",
        items: phase.actions.map((action, index) => actionRow(action, index === 0)),
      },
    ],
  };
}

function plainText(data: ReasoningProcessData): string {
  const lines = [`${data.statusLabel} · ${data.timerText}`];
  for (const phase of data.phases) {
    if (phase.thought) lines.push(phase.thought);
    for (const action of phase.actions) lines.push(`${action.tool} · ${action.detail}`);
  }
  if (data.progressText) lines.push(data.progressText);
  if (data.errorMessage) lines.push(data.errorMessage);
  return lines.join("\n") || PROGRESS_CARD_PLACEHOLDER;
}

/**
 * Glyph for the collapsed summary line. A terminal card is collapsed by default, so this glyph is
 * the default presentation of the outcome — a hardcoded `✓` would badge a failed run as successful.
 */
function collapsedGlyph(state: ReasoningProcessState): string {
  return state === "completed" ? "✓" : state === "error" || state === "stopped" ? "⚠" : "◌";
}

/** Render the local toggle-only variant of the shared Registry data shape. */
export function renderReasoningProcessCard(
  state: CardProgressState,
  caps?: CardCaps,
): { card: Record<string, unknown>; plain: string } {
  if (!cardSupports(caps, "TextBlock") || !cardSupports(caps, "Container") || !cardSupports(caps, "ColumnSet")) {
    return renderProgressCard(state, caps);
  }
  const data = trimForRender(buildReasoningProcessData(state));
  const canToggle = cardSupports(caps, "ActionSet") && cardSupports(caps, "Action.ToggleVisibility");
  const traceVisible = canToggle ? data.traceExpanded : true;
  const body: Record<string, unknown>[] = [
    {
      type: "Container",
      id: "octo-surface-accent-header-reasoning-active",
      style: "accent",
      bleed: true,
      spacing: "None",
      items: [{
        type: "ColumnSet",
        spacing: "None",
        columns: [
          {
            type: "Column",
            width: "stretch",
            items: [
              textBlock(`✦  ${data.title}`, { color: "Accent", weight: "Bolder", spacing: "None" }),
              textBlock(data.timerText, { size: "Small", isSubtle: true, spacing: "Small" }),
            ],
          },
          {
            type: "Column",
            width: "auto",
            items: [textBlock(data.statusLabel, {
              color: data.statusTone,
              weight: "Bolder",
              size: "Small",
              spacing: "None",
            })],
          },
        ],
      }],
    },
    {
      type: "Container",
      id: "trace_panel",
      isVisible: traceVisible,
      spacing: "Large",
      items: [
        ...data.phases.map((phase, index) => phaseBlock(phase, index === 0)),
        ...(data.progressText ? [textBlock(`◌  ${data.progressText}`, { color: "Accent", size: "Small", spacing: "Large" })] : []),
        ...(data.errorMessage ? [{
          type: "Container",
          style: "attention",
          spacing: "Large",
          items: [
            textBlock(data.errorTitle ?? "Generation failed", { weight: "Bolder", color: "Attention", spacing: "None" }),
            textBlock(data.errorMessage, { size: "Small", spacing: "Small" }),
          ],
        }] : []),
      ],
    },
    {
      type: "Container",
      id: "collapsed_panel",
      isVisible: canToggle ? data.traceCollapsed : false,
      spacing: "Medium",
      items: [textBlock(`${collapsedGlyph(data.state)}  ${data.collapsedSummary}`, { size: "Small", isSubtle: true, spacing: "None" })],
    },
  ];
  if (canToggle) {
    body.push({
      type: "Container",
      style: "emphasis",
      bleed: true,
      separator: true,
      spacing: "Large",
      items: [{
        type: "ActionSet",
        horizontalAlignment: "Right",
        actions: [{
          type: "Action.ToggleVisibility",
          id: "reasoning_toggle",
          title: "Show / hide reasoning",
          targetElements: ["trace_panel", "collapsed_panel"],
        }],
      }],
    });
  }
  const card: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: CARD_VERSION,
    body,
    metadata: { octo_layout: OCTO_CARD_LAYOUTS.agentProgressV1 },
  };
  const plain = plainText(data);
  return cardFitsLimits(card, plain, caps)
    ? { card, plain }
    : renderProgressCard(state, caps);
}
