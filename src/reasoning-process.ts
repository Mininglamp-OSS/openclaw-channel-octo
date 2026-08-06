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

const FALLBACK_THOUGHT = "Thinking through…";
const THOUGHT_MAX = 280;
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
  const errorMessage = sanitizeErrorText(state.errorText) ||
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
          : mapped === "error" ? "Interrupted"
            : `${elapsed} · ${phaseCount(phases.length)} · ${toolCallCount(toolCount)}`,
    traceExpanded: active || mapped === "error",
    traceCollapsed: !active && mapped !== "error",
    collapsedSummary: mapped === "answering" ? "Reasoning complete · answer in progress"
      : mapped === "stopped" ? `Kept ${phaseCount(phases.length)} from before the stop`
        : mapped === "error" ? "Interrupted · open to see the steps so far"
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
  return lines.join("\n") || PROGRESS_CARD_PLACEHOLDER;
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
