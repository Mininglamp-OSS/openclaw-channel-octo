import { describe, expect, it } from "vitest";
import {
  buildReasoningProcessData,
  renderReasoningProcessCard,
  sanitizeReasoningThought,
  summarizeToolResult,
} from "./reasoning-process.js";
import { SUBAGENT_WAIT_STEP_TOOL, type CardProgressState } from "./card-render.js";

function state(overrides: Partial<CardProgressState> = {}): CardProgressState {
  return {
    reasoningId: "agent:main:octo:room:run-1",
    phase: "done",
    elapsedMs: 12_000,
    steps: [
      {
        tool: "__thinking__",
        status: "done",
        durationMs: 2_000,
        modelCallId: "call-1",
        thought: "先核对当前目录，再执行检查。",
      },
      {
        tool: "exec",
        status: "done",
        toolCallId: "tool-1",
        summary: "npm",
        resultSummary: "exit 0",
        durationMs: 300,
      },
    ],
    ...overrides,
  };
}

describe("ai.reasoning-process@0.1.0 contract", () => {
  it("builds the completed ViewModel with raw tool names and sanitized action detail", () => {
    const data = buildReasoningProcessData(state());

    expect(data).toMatchObject({
      reasoningId: "agent:main:octo:room:run-1",
      state: "completed",
      title: "已深度思考",
      statusLabel: "已完成",
      statusTone: "Good",
      timerText: "用时 12.0s · 1 段推理 · 1 次工具调用",
      traceExpanded: false,
      traceCollapsed: true,
      collapsedSummary: "已思考 12.0s · 推理过程已收起",
    });
    expect(data.phases).toEqual([
      {
        thought: "先核对当前目录，再执行检查。",
        actions: [{
          tool: "exec",
          detail: "npm · exit 0",
          statusGlyph: "●",
          statusTone: "Good",
        }],
      },
    ]);
    expect(data).not.toHaveProperty("progressText");
    expect(data).not.toHaveProperty("errorTitle");
  });

  it("maps active, answering, stopped, and error phases to contract states", () => {
    expect(buildReasoningProcessData(state({ phase: "tool", elapsedMs: 2_000 }))).toMatchObject({
      state: "reasoning",
      statusLabel: "思考中",
      statusTone: "Accent",
      traceExpanded: true,
      traceCollapsed: false,
      progressText: "正在执行下一步…",
    });
    expect(buildReasoningProcessData(state({ phase: "answering" }))).toMatchObject({
      state: "answering",
      statusLabel: "回答中",
      progressText: "推理已完成，正在生成回答…",
    });
    expect(buildReasoningProcessData(state({ phase: "stopped", elapsedMs: 6_000 }))).toMatchObject({
      state: "stopped",
      statusLabel: "已停止",
      statusTone: "Warning",
      traceExpanded: false,
      traceCollapsed: true,
    });
    expect(buildReasoningProcessData(state({ phase: "error", errorText: "provider timeout" }))).toMatchObject({
      state: "error",
      statusLabel: "生成失败",
      statusTone: "Attention",
      traceExpanded: true,
      traceCollapsed: false,
      errorTitle: "生成失败",
      errorMessage: "provider timeout",
    });
  });

  it("keeps every phase schema-valid when reasoning text or actions are unavailable", () => {
    const data = buildReasoningProcessData(state({
      steps: [{ tool: "read", status: "running", summary: "/work/README.md" }],
    }));

    expect(data.phases).toHaveLength(1);
    expect(data.phases[0]?.thought.length).toBeGreaterThan(0);
    expect(data.phases[0]?.actions).toEqual([{
      tool: "read",
      detail: "/work/README.md",
      statusGlyph: "●",
      statusTone: "Accent",
    }]);
  });

  it("keeps the completed subagent wait duration in action detail", () => {
    const data = buildReasoningProcessData(state({
      steps: [
        { tool: "__thinking__", status: "done", thought: "等待后台任务完成。" },
        { tool: SUBAGENT_WAIT_STEP_TOOL, status: "done", durationMs: 75_000 },
      ],
    }));

    expect(data.phases[0]?.actions[0]?.detail).toBe("子任务已返回 · 75.0s");
  });
});

describe("reasoning detail sanitization", () => {
  it("never exposes raw tool output and only returns allowlisted structural summaries", () => {
    expect(summarizeToolResult("exec", {
      details: { exitCode: 0, status: "completed" },
      content: [{ type: "text", text: "Authorization: Bearer secret-value" }],
    })).toBe("exit 0");
    expect(summarizeToolResult("search", {
      details: { matchCount: 3 },
      content: [{ type: "text", text: "sensitive document contents" }],
    })).toBe("3 results");
    expect(summarizeToolResult("mcp__private__lookup", {
      content: [{ type: "text", text: "password=hunter2" }],
    })).toBe("completed");
  });

  it("redacts secret-shaped or protected internal reasoning and bounds visible text", () => {
    expect(sanitizeReasoningThought("Authorization: Bearer abcdefghijklmnop"))
      .toBe("Thinking through...");
    expect(sanitizeReasoningThought(
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> private completion event",
    )).toBe("Thinking through...");
    expect(sanitizeReasoningThought("x".repeat(600)).length).toBeLessThanOrEqual(281);
  });
});

describe("reasoning process Adaptive Card", () => {
  const caps = {
    elements: new Set(["TextBlock", "Container", "ColumnSet", "ActionSet"]),
    actions: new Set(["Action.ToggleVisibility"]),
    maxNodes: 200,
  };

  it("renders the contract layout with toggle-only v1 interaction", () => {
    const { card, plain } = renderReasoningProcessCard(state(), caps);
    const json = JSON.stringify(card);

    expect(card.metadata).toEqual({ octo_layout: "agent_progress_v1" });
    expect(json).toContain('"id":"trace_panel"');
    expect(json).toContain('"id":"collapsed_panel"');
    expect(json).toContain('"type":"Action.ToggleVisibility"');
    expect(json).not.toContain("Action.Submit");
    expect(json).not.toContain("reasoning_stop");
    expect(plain).toContain("先核对当前目录，再执行检查。");
    expect(plain).toContain("exec · npm · exit 0");
  });

  it("degrades to an expanded display-only card when ToggleVisibility is unavailable", () => {
    const { card } = renderReasoningProcessCard(state(), {
      elements: new Set(["TextBlock", "Container", "ColumnSet"]),
      actions: new Set(),
      maxNodes: 200,
    });
    const body = card.body as Array<Record<string, unknown>>;
    const trace = body.find((item) => item.id === "trace_panel");

    expect(trace).toMatchObject({ id: "trace_panel", isVisible: true });
    expect(JSON.stringify(card)).not.toContain("ActionSet");
    expect(JSON.stringify(card)).not.toContain("Action.ToggleVisibility");
  });
});
