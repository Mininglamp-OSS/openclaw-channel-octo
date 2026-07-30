import { createHash } from "node:crypto";
import { CARD_PLACEHOLDER, CARD_VERSION } from "./types.js";
import type { CardTemplateRef, CardTemplatingCapability } from "./api-fetch.js";
import { cardFitsLimits } from "./card-limits.js";
import {
  OCTO_CARD_LAYOUTS,
  SUBAGENT_WAIT_STEP_TOOL,
  cardSupports,
  fmtDuration,
  isSensitive,
  reduceUrlsInText,
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

/** Shared producer contract for ai.reasoning-process@0.1.0 and bounded successor 0.2.0. */
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

const FALLBACK_THOUGHT = "Thinking through...";
const THOUGHT_MAX = 280;
const TOOL_NAME_MAX = 80;
const MAX_RENDERED_PHASES = 6;
const MAX_RENDERED_ACTIONS = 12;
const REASONING_TEMPLATE_ID = "ai.reasoning-process";
const TEMPLATE_WIRE = "template-ref/v1";
/** Supported producer contracts in preference order, newest first. */
const SUPPORTED_TEMPLATE_VERSIONS: readonly string[] = ["0.2.0", "0.1.0"];
export const REASONING_ID_MAX_LENGTH = 512;

/** Preserve short IDs; use a stable collision-resistant digest instead of unsafe truncation. */
export function buildReasoningProcessId(sessionKey: string, runId?: string): string {
  const raw = runId ? `${sessionKey}:${runId}` : sessionKey;
  if ([...raw].length <= REASONING_ID_MAX_LENGTH) return raw;
  return `octo-reasoning:sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * Views this producer supplies data for. Compatibility is a **data-contract** check only: the
 * template must own a view for every state this producer emits, or the server cannot render the
 * frame. `submit_actions` is deliberately not part of it — the template is a server-side asset
 * rendered server-side, so which controls it shows is presentation the server owns, not something
 * this producer either implements or vetoes. Requiring an action would also force a template that
 * hides its controls to be judged incompatible, silently dropping the whole card to Model B.
 */
const REQUIRED_VIEWS = [
  { name: "active", states: ["reasoning", "answering"], wireProfile: "octo/v2" },
  { name: "error", states: ["error"], wireProfile: "octo/v2" },
  { name: "result", states: ["completed", "stopped"], wireProfile: "octo/v1" },
] as const;

/**
 * Select the newest Bot-catalog entry with the contract shape this producer implements.
 *
 * A catalog advertising the successor alongside its predecessor is the normal state for the whole
 * rollout window, so preferring the newest is what keeps the feature engaged there.
 *
 * Ambiguity is judged per version and over every entry claiming this template id, not over the
 * view-compatible subset: `template_ref` carries only `{id, version}`, so two entries claiming one
 * version cannot be told apart on the wire and the server may resolve the one rejected here. A
 * version in that state is skipped rather than selected; an older unambiguous version is still
 * usable, and ambiguity in a version that would not have been selected costs nothing.
 */
export function selectReasoningProcessTemplate(
  templating: CardTemplatingCapability | undefined,
): CardTemplateRef | null {
  if (!templating?.supported || templating.wire !== TEMPLATE_WIRE) return null;
  const claimed = templating.templates.filter((template) => template.id === REASONING_TEMPLATE_ID);
  const compatible = claimed.filter((template) => {
    if (!SUPPORTED_TEMPLATE_VERSIONS.includes(template.version)) return false;
    return REQUIRED_VIEWS.every((required) => {
      const view = template.views.find((candidate) => candidate.name === required.name);
      if (!view || view.wire_profile !== required.wireProfile) return false;
      const states = new Set(view.states);
      return required.states.every((state) => states.has(state));
    });
  });
  for (const version of SUPPORTED_TEMPLATE_VERSIONS) {
    const match = compatible.find((template) => template.version === version);
    if (!match) continue;
    if (claimed.filter((template) => template.version === version).length > 1) continue;
    return { id: match.id, version: match.version };
  }
  return null;
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

/** Reasoning lane text is visible to channel members, so fail closed on protected/secret shapes. */
export function sanitizeReasoningThought(text: string | undefined): string {
  if (!text) return FALLBACK_THOUGHT;
  let normalized = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized ||
      normalized.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") ||
      normalized.includes("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")) {
    return FALLBACK_THOUGHT;
  }
  normalized = reduceUrlsInText(normalized).replace(/\s+/g, " ").trim();
  if (!normalized || isSensitive(normalized, true)) return FALLBACK_THOUGHT;
  return normalized.length > THOUGHT_MAX ? normalized.slice(0, THOUGHT_MAX) + "…" : normalized;
}

/**
 * Sanitizing one thought costs several regex passes over up to MAX_REASONING_CAPTURE chars, and
 * every debounce flush re-derives phases from the whole run. Steps are append-only and a thought
 * only mutates while its model call streams, so cache per step and re-sanitize on change. Keyed by
 * the step object, so entries die with the card entry.
 */
const sanitizedThoughts = new WeakMap<CardStep, { raw: string; clean: string }>();

function cachedThought(step: CardStep): string {
  const raw = step.thought ?? "";
  const cached = sanitizedThoughts.get(step);
  if (cached && cached.raw === raw) return cached.clean;
  const clean = sanitizeReasoningThought(step.thought);
  sanitizedThoughts.set(step, { raw, clean });
  return clean;
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
    const label = step.status === "running" ? "Waiting for subtask..." : "Subtask returned";
    const duration = fmtDuration(step.durationMs);
    return duration ? `${label} · ${duration}` : label;
  }
  const error = sanitizeErrorText(step.error);
  const parts = [step.summary, step.status === "error" ? error : step.resultSummary]
    .filter((value): value is string => !!value);
  if (parts.length > 0) return parts.join(" · ");
  if (step.status === "running") return "Running...";
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
      current = { thought: FALLBACK_THOUGHT, actions: [] };
      phases.push(current);
    }
    current.actions.push(actionFromStep(step));
  }
  if (phases.length === 0) phases.push({ thought: FALLBACK_THOUGHT, actions: [] });
  if (opts.synthesizeEmptyActions === false) return phases;
  const thinkingSteps = steps.filter((step) => step.tool === "__thinking__");
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index]!;
    if (phase.actions.length > 0) continue;
    const thinking = thinkingSteps[index];
    const duration = fmtDuration(thinking?.durationMs);
    const detail = thinking?.status === "running" ? "Planning next step..."
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
  const errorMessage = sanitizeErrorText(state.errorText) ||
    (state.phase === "expired"
      ? "Timed out waiting for the background task."
      : "Reasoning was interrupted. Completed steps were preserved.");
  const base: ReasoningProcessData = {
    reasoningId: state.reasoningId?.trim() || "octo-progress",
    state: mapped,
    title: "已深度思考",
    statusLabel: mapped === "reasoning" ? "思考中"
      : mapped === "answering" ? "回答中"
        : mapped === "completed" ? "已完成"
          : mapped === "stopped" ? "已停止"
            : "生成失败",
    statusTone: mapped === "reasoning" || mapped === "answering" ? "Accent"
      : mapped === "completed" ? "Good"
        : mapped === "stopped" ? "Warning"
          : "Attention",
    timerText: mapped === "reasoning" ? "正在深度思考…"
      : mapped === "answering" ? "正在生成回答…"
        : mapped === "stopped" ? `已思考 ${elapsed} · 已停止于第 ${phases.length} 段`
          : mapped === "error" ? "已中断"
            : `用时 ${elapsed} · ${phases.length} 段推理 · ${toolCount} 次工具调用`,
    traceExpanded: active || mapped === "error",
    traceCollapsed: !active && mapped !== "error",
    collapsedSummary: mapped === "answering" ? "推理已完成 · 回答正在生成"
      : mapped === "stopped" ? `已保留停止前的 ${phases.length} 段推理过程`
        : mapped === "error" ? "生成已中断 · 点击可查看停止前的过程"
          : mapped === "completed" ? `已思考 ${elapsed} · 推理过程已收起`
            : "推理仍在进行 · 点击可查看当前过程",
    phases,
  };
  if (mapped === "reasoning") {
    base.progressText = state.phase === "paused" ? "Waiting for subtask..."
      : state.phase === "resuming" ? "Subtask returned. Wrapping up..."
        : "Working through...";
  } else if (mapped === "answering") {
    base.progressText = "推理已完成，正在生成回答…";
  } else if (mapped === "error") {
    base.errorTitle = "生成失败";
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

/** Build bounded Registry data without inventing synthetic tool actions for empty model calls. */
export function buildReasoningProcessWireData(state: CardProgressState): ReasoningProcessData | null {
  const phases = phasesFromSteps(state.steps, { synthesizeEmptyActions: false })
    .filter((phase) => phase.actions.length > 0);
  if (phases.length === 0) return null;
  return trimForRender(buildReasoningProcessDataWithPhases(state, phases));
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
      textBlock(phase.thought, { size: "Small", spacing: "None" }),
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
    lines.push(phase.thought);
    for (const action of phase.actions) lines.push(`${action.tool} · ${action.detail}`);
  }
  if (data.progressText) lines.push(data.progressText);
  if (data.errorMessage) lines.push(data.errorMessage);
  return lines.join("\n") || CARD_PLACEHOLDER;
}

/** Render the local toggle-only variant of the shared 0.1.0/0.2.0 data contract. */
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
            textBlock(data.errorTitle ?? "生成失败", { weight: "Bolder", color: "Attention", spacing: "None" }),
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
      items: [textBlock(`✓  ${data.collapsedSummary}`, { size: "Small", isSubtle: true, spacing: "None" })],
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
          title: "显示 / 隐藏推理",
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
