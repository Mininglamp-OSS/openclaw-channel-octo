import { describe, expect, it } from "vitest";
import {
  buildReasoningProcessWireData,
  buildReasoningProcessData,
  renderReasoningProcessCard,
  resolveReasoningThought,
  sanitizeReasoningThought,
  selectReasoningProcessTemplate,
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

describe("ai.reasoning-process successor-compatible contract", () => {
  it("builds the completed ViewModel with raw tool names and sanitized action detail", () => {
    const data = buildReasoningProcessData(state());

    expect(data).toMatchObject({
      reasoningId: "agent:main:octo:room:run-1",
      state: "completed",
      title: "Reasoning",
      statusLabel: "Done",
      statusTone: "Good",
      timerText: "12.0s · 1 phase · 1 tool call",
      traceExpanded: false,
      traceCollapsed: true,
      collapsedSummary: "12.0s · trace collapsed",
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
      statusLabel: "Thinking",
      statusTone: "Accent",
      traceExpanded: true,
      traceCollapsed: false,
      progressText: "Working through…",
    });
    expect(buildReasoningProcessData(state({ phase: "paused" }))).toMatchObject({
      state: "reasoning",
      progressText: "Waiting for subtask…",
    });
    expect(buildReasoningProcessData(state({ phase: "resuming" }))).toMatchObject({
      state: "reasoning",
      progressText: "Subtask returned. Wrapping up…",
    });
    expect(buildReasoningProcessData(state({ phase: "answering" }))).toMatchObject({
      state: "answering",
      statusLabel: "Answering",
      progressText: "Reasoning complete. Writing the answer…",
    });
    expect(buildReasoningProcessData(state({ phase: "stopped", elapsedMs: 6_000 }))).toMatchObject({
      state: "stopped",
      statusLabel: "Stopped",
      statusTone: "Warning",
      traceExpanded: false,
      traceCollapsed: true,
      // `stopped at phase N` is an ordinal position, matching the copy it replaced — the count
      // reading ("stopped at N phases") happens to share the number and must not creep back in.
      timerText: "6.0s · stopped at phase 1",
      collapsedSummary: "Kept 1 phase from before the stop",
    });
    // 终态一律折叠(与 Model B 的 renderProgressCard 一致):失败卡默认收起,
    // collapsedSummary 的 "open to see the steps so far" 才有意义 —— 展开时它永不显示。
    expect(buildReasoningProcessData(state({ phase: "error", errorText: "provider timeout" }))).toMatchObject({
      state: "error",
      statusLabel: "Failed",
      statusTone: "Attention",
      traceExpanded: false,
      traceCollapsed: true,
      collapsedSummary: "Interrupted · open to see the steps so far",
      errorTitle: "Generation failed",
      errorMessage: "provider timeout",
    });
    // expired 走同一条 error 契约状态,同样折叠。
    expect(buildReasoningProcessData(state({ phase: "expired" }))).toMatchObject({
      state: "error",
      traceExpanded: false,
      traceCollapsed: true,
      errorMessage: "Timed out waiting for the background task.",
    });
  });

  it("renders actions with no thought line when a phase has no model call behind it", () => {
    const data = buildReasoningProcessData(state({
      steps: [{ tool: "read", status: "running", summary: "/work/README.md" }],
    }));

    expect(data.phases).toHaveLength(1);
    // Structural, not a reasoning state: there was no model call, so claiming a thought here would
    // be inventing one.
    expect(data.phases[0]?.thought).toBe("");
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

    expect(data.phases[0]?.actions[0]?.detail).toBe("Subtask returned · 1m 15s");
  });

  it("uses English fallback copy when phase and action details are unavailable", () => {
    const detailFor = (step: CardProgressState["steps"][number]): string | undefined =>
      buildReasoningProcessData(state({ steps: [step] })).phases[0]?.actions[0]?.detail;

    expect(detailFor({ tool: "__thinking__", status: "running" })).toBe("Planning next step…");
    expect(detailFor({ tool: "__thinking__", status: "error" })).toBe("Phase stopped");
    expect(detailFor({ tool: "__thinking__", status: "done" })).toBe("Phase complete");
    expect(detailFor({ tool: "read", status: "running" })).toBe("Running…");
    expect(detailFor({ tool: "read", status: "error" })).toBe("Call failed");
    expect(detailFor({ tool: "read", status: "done" })).toBe("Completed");
    expect(detailFor({ tool: SUBAGENT_WAIT_STEP_TOOL, status: "running" }))
      .toBe("Waiting for subtask…");

    expect(buildReasoningProcessData(state({ phase: "expired" })).errorMessage)
      .toBe("Timed out waiting for the background task.");
    expect(buildReasoningProcessData(state({ phase: "error" })).errorMessage)
      .toBe("Reasoning was interrupted. Completed steps were preserved.");
  });

  it("builds bounded wire data from real actions and drops action-less model-call phases", () => {
    const data = buildReasoningProcessWireData(state({
      phase: "answering",
      steps: [
        { tool: "__thinking__", status: "done", modelCallId: "call-1", thought: "核对输入。" },
        { tool: "read", status: "done", toolCallId: "tool-1", summary: "README.md" },
        { tool: "__thinking__", status: "running", modelCallId: "call-2", thought: "组织答案。" },
      ],
    }));

    expect(data).not.toBeNull();
    expect(data?.state).toBe("answering");
    expect(data?.phases).toEqual([{
      thought: "核对输入。",
      actions: [{ tool: "read", detail: "README.md", statusGlyph: "●", statusTone: "Good" }],
    }]);
  });

  it("returns no wire data before a real displayable action exists", () => {
    expect(buildReasoningProcessWireData(state({
      phase: "reasoning" as never,
      steps: [{ tool: "__thinking__", status: "running", thought: "正在计划。" }],
    }))).toBeNull();
  });
});

describe("reasoning process template discovery", () => {
  const template = (version: string) => ({
    id: "ai.reasoning-process",
    version,
    views: [
      { name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: ["reasoning_stop"] },
      { name: "result", states: ["completed", "stopped"], wire_profile: "octo/v1", submit_actions: [] },
      { name: "error", states: ["error"], wire_profile: "octo/v2", submit_actions: ["reasoning_retry"] },
    ],
  });

  it.each(["0.1.0", "0.2.0", "0.3.0", "1.0.0", "9.8.7"])(
    "selects the sole compatible manifest version %s without a local allowlist",
    (version) => {
      expect(selectReasoningProcessTemplate({
        supported: true,
        wire: "template-ref/v1",
        templates: [template(version)],
      })).toEqual({ id: "ai.reasoning-process", version });
    },
  );

  it.each(["", "   ", " 0.3.0", "0.3.0 "])(
    "fails closed for an empty or whitespace-padded manifest version %j",
    (version) => {
      expect(selectReasoningProcessTemplate({
        supported: true,
        wire: "template-ref/v1",
        templates: [template(version)],
      })).toBeNull();
    },
  );

  it("fails closed when multiple compatible versions are advertised without a preference signal", () => {
    // The manifest is a capability set, not a preference-ordered list. The consumer must not
    // guess which version the server intended when more than one compatible ref is available.
    for (const templates of [
      [template("0.1.0"), template("0.2.0")],
      [template("0.3.0"), template("0.2.0")],
      [template("0.2.0"), template("0.1.0")],
    ]) {
      expect(selectReasoningProcessTemplate({ supported: true, wire: "template-ref/v1", templates }))
        .toBeNull();
    }
  });

  it("selects the exact server-configured ref when the catalog advertises multiple compatible versions", () => {
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "template-ref/v1",
      templates: [template("0.2.0"), template("0.3.0")],
    }, { id: "ai.reasoning-process", version: "0.3.0" })).toEqual({
      id: "ai.reasoning-process",
      version: "0.3.0",
    });
  });

  it("fails closed when the configured ref is absent, malformed, or points at an incompatible entry", () => {
    const incompatible = { ...template("0.3.0"), views: template("0.3.0").views.slice(0, 2) };
    const templating = {
      supported: true,
      wire: "template-ref/v1",
      templates: [template("0.2.0"), incompatible],
    };

    expect(selectReasoningProcessTemplate(templating, null)).toBeNull();
    expect(selectReasoningProcessTemplate(templating, { id: "ai.reasoning-process", version: "0.4.0" }))
      .toBeNull();
    expect(selectReasoningProcessTemplate(templating, { id: "ai.reasoning-process", version: "0.3.0" }))
      .toBeNull();
  });

  it("selects the sole compatible version when another advertised version has incompatible views", () => {
    const incompatible = { ...template("0.2.0"), views: template("0.2.0").views.slice(0, 2) };
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "template-ref/v1",
      templates: [incompatible, template("0.3.0")],
    })).toEqual({ id: "ai.reasoning-process", version: "0.3.0" });
  });

  it("still fails closed when one version is advertised twice", () => {
    // Two catalog entries claiming the same contract are genuinely ambiguous: nothing here can
    // tell which one the server would render.
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "template-ref/v1",
      templates: [template("0.2.0"), template("0.2.0")],
    })).toBeNull();
  });

  it("treats a duplicated version as ambiguous even when only one side has compatible views", () => {
    // template_ref carries only {id, version}, so it cannot say which of the two entries was
    // meant — the server may resolve the one this producer rejected. Judging ambiguity after the
    // view filter would hide exactly that case.
    const incompatible = { ...template("0.2.0"), views: template("0.2.0").views.slice(0, 2) };
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "template-ref/v1",
      templates: [template("0.2.0"), incompatible],
    })).toBeNull();
  });

  it("fails closed for incompatible view/state shapes", () => {
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "template-ref/v1",
      templates: [{ ...template("0.2.0"), views: template("0.2.0").views.slice(0, 2) }],
    })).toBeNull();
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "other-wire",
      templates: [template("0.2.0")],
    })).toBeNull();
  });

  it.each([
    {
      name: "unknown submit action",
      duplicate: {
        name: "active",
        states: ["reasoning", "answering"],
        wire_profile: "octo/v2",
        submit_actions: ["future_action"],
      },
    },
    {
      name: "incompatible wire profile",
      duplicate: {
        name: "active",
        states: ["reasoning", "answering"],
        wire_profile: "octo/v1",
        submit_actions: ["reasoning_stop"],
      },
    },
  ])("fails closed when a duplicate required view hides an $name", ({ duplicate }) => {
    const candidate = template("0.3.0");
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "template-ref/v1",
      templates: [{ ...candidate, views: [...candidate.views, duplicate] }],
    })).toBeNull();
  });

  // Controls are rendered by the server but must still be understood by this consumer. A future
  // action cannot be allowed to produce a clickable control that this plugin only ignores.
  it.each(["active", "result", "error"] as const)(
    "fails closed when the %s view advertises an unhandled submit action",
    (viewName) => {
      const candidate = template("0.2.0");
      expect(selectReasoningProcessTemplate({
        supported: true,
        wire: "template-ref/v1",
        templates: [{
          ...candidate,
          views: candidate.views.map((view) => view.name === viewName
            ? { ...view, submit_actions: [...view.submit_actions, "future_action"] }
            : view),
        }],
      })).toBeNull();
    },
  );

  it("stays compatible when the template advertises no controls at all", () => {
    // The intended shape once reasoning stop/regenerate is dropped from the template: run
    // control is not a card action, so the card renders without those buttons.
    const candidate = template("0.2.0");
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "template-ref/v1",
      templates: [{
        ...candidate,
        views: candidate.views.map((view) => ({ ...view, submit_actions: [] })),
      }],
    })).toEqual({ id: "ai.reasoning-process", version: "0.2.0" });
  });

  it("keeps known controls scoped to the views that define their presentation contract", () => {
    const candidate = template("0.3.0");
    expect(selectReasoningProcessTemplate({
      supported: true,
      wire: "template-ref/v1",
      templates: [{
        ...candidate,
        views: candidate.views.map((view) => view.name === "result"
          ? { ...view, submit_actions: ["reasoning_retry"] }
          : view),
      }],
    })).toBeNull();
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
      .toBe("Reasoning hidden — matched a redaction rule");
    expect(sanitizeReasoningThought(
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> private completion event",
    )).toBe("Reasoning hidden — matched a redaction rule");
    // A real chain of thought routinely runs past the old 280-char cap and used to be cut
    // mid-sentence, losing the part that says what the model was about to do next. 600 chars now
    // survive intact; the cap is still hard, so 2000 is truncated with an ellipsis.
    expect(sanitizeReasoningThought("x".repeat(600))).toBe("x".repeat(600));
    // 精确钉住:`<= 1201` 对 [600,1200] 区间内任何上限都成立,起不到锚定作用。
    const long = sanitizeReasoningThought("x".repeat(2000));
    expect(long.length).toBe(1201);
    expect(long.endsWith("…")).toBe(true);
  });

  /**
   * The four outcomes used to collapse into one string. "Redacted" is the only one that tells an
   * operator where to look, so it must never be confusable with "the model produced nothing".
   */
  /**
   * recordCardReasoning 在非 snapshot 时拼接(`previous + text`),一个 __thinking__ 步骤可能
   * 收到两次 model call 的文本。全等匹配一旦被拼接破坏,占位句会被判成 `text`,把宿主的英文
   * 诊断句原样渲染到群卡上 —— brief 明确列为非目标的结果。
   */
  it("holds the no-summary classification under concatenation", () => {
    const placeholder = "Native reasoning was produced; no summary text was returned.";
    expect(resolveReasoningThought(placeholder).kind).toBe("no-summary");
    // 只有占位句(前后带空白)仍是 no-summary。
    expect(resolveReasoningThought(`  ${placeholder}  `).kind).toBe("no-summary");
    // 占位句被剥掉后还有真实文本 → 展示真实文本,且绝不渲染宿主诊断句。
    const mixed = resolveReasoningThought(`${placeholder} Checking the reducer.`);
    expect(mixed.kind).toBe("text");
    expect(mixed.text).toBe("Checking the reducer.");
    expect(mixed.text).not.toContain("Native reasoning was produced");
  });

  it("classifies the four thought outcomes distinguishably", () => {
    expect(resolveReasoningThought("Checking the reducer.")).toEqual({
      kind: "text",
      text: "Checking the reducer.",
    });
    expect(resolveReasoningThought(undefined)).toEqual({ kind: "none", text: "" });
    expect(resolveReasoningThought("   ")).toEqual({ kind: "none", text: "" });
    // Verbatim host placeholder: OpenClaw emits this for a signed reasoning block with empty text
    // (OpenAI Responses with no summary, Anthropic redacted_thinking).
    expect(resolveReasoningThought("Native reasoning was produced; no summary text was returned."))
      .toEqual({ kind: "no-summary", text: "Reasoned without a visible summary" });
    expect(resolveReasoningThought("Authorization: Bearer abcdefghijklmnop")).toEqual({
      kind: "redacted",
      text: "Reasoning hidden — matched a redaction rule",
    });
    // A thought whose only content is an unparseable URI is erased by URL reduction. Withheld, not
    // absent — a parseable one keeps its registrable domain and stays `text`.
    expect(resolveReasoningThought("ftp://:::/").kind).toBe("redacted");
    expect(resolveReasoningThought("https://internal-admin.corp.example.com/reset?u=1")).toEqual({
      kind: "text",
      text: "https://example.com",
    });
  });

  it("never renders the host's own diagnostic sentence onto a card", () => {
    const { card, plain } = renderReasoningProcessCard(state({
      steps: [
        {
          tool: "__thinking__",
          status: "done",
          modelCallId: "call-1",
          thought: "Native reasoning was produced; no summary text was returned.",
        },
        { tool: "exec", status: "done", toolCallId: "tool-1", summary: "npm" },
      ],
    }), {
      elements: new Set(["TextBlock", "Container", "ColumnSet", "ActionSet"]),
      actions: new Set(["Action.ToggleVisibility"]),
      maxNodes: 200,
    });

    const json = JSON.stringify(card);
    expect(json).not.toContain("Native reasoning was produced");
    expect(plain).not.toContain("Native reasoning was produced");
    expect(json).toContain("Reasoned without a visible summary");
  });

  it("reduces scheme-less credentials and host paths before rendering reasoning text", () => {
    expect(sanitizeReasoningThought("Connecting with alice:hunter2@db.example.com/private now"))
      .toBe("Connecting with https://example.com now");
    expect(sanitizeReasoningThought("Fetching internal-admin.corp.example.com/reset?u=1"))
      .toBe("Fetching https://example.com");
  });

  it("reduces scheme-less credentials before rendering tool names", () => {
    const data = buildReasoningProcessData(state({
      steps: [
        { tool: "__thinking__", status: "done", thought: "检查连接。" },
        { tool: "alice:hunter2@db.example.com/private", status: "done" },
      ],
    }));

    expect(data.phases[0]?.actions[0]?.tool).toBe("https://example.com");
  });

  it("re-sanitizes a thought that keeps streaming into the same step", () => {
    // Sanitized thoughts are cached per step to keep re-rendering off the O(run length) path.
    // A streaming model call mutates the same step object, so a stale clean value must never
    // survive the text turning sensitive.
    const step = { tool: "__thinking__", status: "done" as const, thought: "Checking the reducer." };
    const steps = [step, { tool: "read", status: "done" as const, summary: "…/src/a.ts" }];

    expect(buildReasoningProcessData(state({ steps })).phases[0]?.thought)
      .toBe("Checking the reducer.");

    step.thought = "Checking the reducer. Authorization: Bearer abcdefghijklmnop";
    expect(buildReasoningProcessData(state({ steps })).phases[0]?.thought)
      .toBe("Reasoning hidden — matched a redaction rule");

    step.thought = "Checking the reducer again.";
    expect(buildReasoningProcessData(state({ steps })).phases[0]?.thought)
      .toBe("Checking the reducer again.");
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

  /**
   * A terminal card is collapsed by default, and the error block lives inside `trace_panel`. The
   * reason therefore has to ride in an always-visible element or a failed run renders as a bare
   * `Failed` badge with no cause — the regression `renderProgressCard` avoids by putting the reason
   * in its header. Asserted against the body elements outside `trace_panel`, i.e. what the reader
   * sees before clicking anything.
   */
  it("keeps the failure reason visible on a collapsed error card", () => {
    const { card } = renderReasoningProcessCard(
      state({ phase: "error", errorText: "provider timeout" }),
      caps,
    );
    const body = card.body as Array<Record<string, unknown>>;
    const withoutTrace = JSON.stringify(body.filter((item) => item.id !== "trace_panel"));

    expect(body.find((item) => item.id === "trace_panel")).toMatchObject({ isVisible: false });
    expect(withoutTrace).toContain("provider timeout");
    // The collapsed summary is the default presentation of the outcome, so it must not badge a
    // failure with the success glyph.
    expect(withoutTrace).toContain("⚠");
    expect(withoutTrace).not.toContain("✓");
  });

  it("labels an expired wait distinctly from an interrupted run", () => {
    const { card } = renderReasoningProcessCard(state({ phase: "expired" }), caps);
    const body = card.body as Array<Record<string, unknown>>;
    const withoutTrace = JSON.stringify(body.filter((item) => item.id !== "trace_panel"));

    expect(withoutTrace).toContain("Wait timed out");
    expect(withoutTrace).not.toContain("Interrupted");
  });
});
