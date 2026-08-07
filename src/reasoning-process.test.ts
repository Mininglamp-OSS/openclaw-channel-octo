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
    // 长度类断言必须用自然语言:长重复串会被 isSensitive 当成高熵串整段抹掉(实测返回 43 字符的
    // REDACTED_THOUGHT),那样测的就不是截断而是脱敏。
    const prose = (runes: number): string => {
      const unit = "I need to check the runtime before answering. ";
      return unit.repeat(Math.ceil(runes / unit.length)).slice(0, runes);
    };
    // sanitize 用「已发布版本里最宽的上限」,按版本收口在 wire 边界(见下方 describe)。
    expect(sanitizeReasoningThought(prose(2000))).toBe(prose(2000));
    // 注意还有第三道上限:reduceUrlsInText 入口的 REDUCE_INPUT_MAX = 4000 会先按空白边界切,
    // 所以 sanitize 这一层的 "…" 截断在 4000 上永不可达 —— 只断言不超过那道界。
    expect([...sanitizeReasoningThought(prose(5000))].length).toBeLessThanOrEqual(4000);
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

/**
 * 契约收口按**服务端选中的版本**做,不是一个模块常量。超限的代价不是内容变短,而是确定性 400 →
 * entry.skip:首帧被拒则整个 session 没有卡片,中途 edit 被拒则用户正在看的卡冻结在进行中。
 * 数字取自服务端 handoff 的 data.schema.json(0.4.0 见 octo-server#712)。
 */
describe("wire data clamps to the selected template version", () => {
  const withThought = (thought: string, summary = "npm"): CardProgressState => ({
    reasoningId: "r", phase: "tool", elapsedMs: 5_000,
    steps: [
      { tool: "__thinking__", status: "done", modelCallId: "c1", thought },
      { tool: "exec", status: "done", toolCallId: "t1", summary, resultSummary: "exit 0" },
    ],
  });
  const runes = (s: string | undefined): number => [...String(s)].length;
  /** 自然语言:长重复串会被 isSensitive 判成高熵串整段抹掉(长 CJK 实测也会),测不到截断。 */
  const prose = (n: number): string => {
    const unit = "I need to check the runtime before answering. ";
    return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  };

  it.each(["0.2.0", "0.3.0"])("caps thought at the %s bound of 281", (version) => {
    const data = buildReasoningProcessWireData(withThought(prose(5_000)), version);
    expect(runes(data!.phases[0]!.thought)).toBe(281);
  });

  it("lets 0.4.0 through to its wider bound", () => {
    const data = buildReasoningProcessWireData(withThought(prose(5_000)), "0.4.0");
    const n = runes(data!.phases[0]!.thought);
    // 断言的是「版本门起作用」+「不越契约」,不钉死具体数字:上游还有一道
    // REDUCE_INPUT_MAX = 4000(card-render.ts),它先按空白边界切,所以实际发不到 4001。
    // 也就是说 0.4.0 放开的那 1 个字符余量已被那道界吃掉。
    expect(n).toBeGreaterThan(281);
    expect(n).toBeLessThanOrEqual(4001);
  });

  it.each([
    ["未列出的新版本", "9.9.9"],
    ["版本未知", undefined],
  ])("falls back to the conservative bound when %s", (_label, version) => {
    // 保守方向:表没更新时内容变短,但永不因超限被拒。
    const data = buildReasoningProcessWireData(withThought(prose(5_000)), version);
    expect(runes(data!.phases[0]!.thought)).toBe(281);
  });

  it("caps timerText, which carries the sanitized error detail on a failed turn", () => {
    // #202 把清洗后的失败原因折进了 timerText,实测 error 135 / expired 138 runes,超过契约 128。
    const state = withThought("核对输入。");
    for (const phase of ["error", "expired"] as const) {
      const data = buildReasoningProcessWireData({ ...state, phase, errorText: "x".repeat(400) }, "0.3.0");
      expect(runes(data!.timerText)).toBeLessThanOrEqual(128);
    }
  });

  it("caps actions[].detail, which had no length bound at all", () => {
    const data = buildReasoningProcessWireData(withThought("核对输入。", "x".repeat(500)), "0.3.0");
    expect(runes(data!.phases[0]!.actions[0]!.detail)).toBeLessThanOrEqual(192);
  });

  it("counts the truncation marker inside the reasoningId contract bound", () => {
    const data = buildReasoningProcessWireData({
      ...withThought("核对输入。"),
      reasoningId: "r".repeat(513),
    }, "0.3.0");
    expect(runes(data!.reasoningId)).toBeLessThanOrEqual(512);
  });

  it("truncates by code point so a surrogate pair is never split", () => {
    const data = buildReasoningProcessWireData(withThought("🙂".repeat(1_000)), "0.3.0");
    const thought = data!.phases[0]!.thought;
    expect(runes(thought)).toBeLessThanOrEqual(281);
    // 孤立代理会渲染成 �。按码点切之后不该出现。
    expect(/[\uD800-\uDFFF]/.test(thought.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
  });
});

/**
 * 宿主内部上下文标记的绕过形态。评审在 merge-base c81df55 上复现了 C/D/E 三种泄漏 —— 这一类
 * 不是本 PR 引入的,但在这里一并收掉:标记散开时固定子串匹配不上,而标记后面的内容会原样进
 * 群可见卡片。
 */
describe("internal-context marker cannot be split apart", () => {
  // payload 必须是**无关键词**的普通散文:带 credential/token 之类的词会触发 isSensitive,
  // 测试就会因为脱敏而通过、而不是因为标记检查 —— 那是假阳性。
  const payload = "the meeting notes are in the shared folder upstairs";
  const P = "Native reasoning was produced; no summary text was returned.";

  it.each([
    ["完整标记", "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> " + payload],
    ["占位句在标记之前", P + " <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> " + payload],
    ["占位句插入标记内部", "<<<BEGIN_OPENCLAW_INTERNAL_" + P + "CONTEXT>>> " + payload],
    ["占位句插入两处", "<<<BEGIN_OPENCLAW_" + P + "INTERNAL_" + P + "CONTEXT>>> " + payload],
    ["下划线被替换", "<<<BEGIN_OPENCLAW_INTERNAL~CONTEXT>>> " + payload],
    ["END 变体", "<<<END_OPENCLAW_INTERNAL~CONTEXT>>> " + payload],
    // 只有容忍式填充能挡的形态:分隔符从下划线换成空格,窄正则要求 BEGIN_OPENCLAW_INTERNAL
    // 逐字相连,一个都抓不到。
    ["分隔符换成空格", "<<< BEGIN OPENCLAW INTERNAL CONTEXT >>> " + payload],
    ["分隔符换成连字符", "<<<BEGIN-OPENCLAW-INTERNAL-CONTEXT>>> " + payload],
  ])("blocks %s", (_label, input) => {
    const result = resolveReasoningThought(input);
    expect(result.kind).toBe("redacted");
    expect(result.text).not.toContain("meeting notes");
  });
});

/**
 * 逐字段 clamp 挡不住总量:6 个 phase 各自用满 0.4.0 的 4001 就是 ~24K runes(CJK 约 72 KB),
 * 而模板发送路径没有 cardFitsLimits 那样的体积兜底,越界即 400 → entry.skip → 整个 session
 * 没有卡片。
 */
describe("wire data budgets total thought across phases", () => {
  const manyPhases = (
    perPhase: number,
    count: number,
    unit = "I need to check the runtime before answering. ",
  ): CardProgressState => {
    const thought = unit.repeat(Math.ceil(perPhase / unit.length)).slice(0, perPhase);
    const steps: CardProgressState["steps"] = [];
    for (let index = 0; index < count; index++) {
      steps.push({ tool: "__thinking__", status: "done", modelCallId: "c" + index, thought });
      steps.push({ tool: "exec", status: "done", toolCallId: "t" + index, summary: "npm", resultSummary: "exit 0" });
    }
    return { reasoningId: "r", phase: "tool", elapsedMs: 5_000, steps };
  };
  const totalRunes = (data: ReturnType<typeof buildReasoningProcessWireData>): number =>
    data!.phases.reduce((sum, phase) => sum + [...phase.thought].length, 0);

  it("keeps six maxed-out phases inside a total budget on 0.4.0", () => {
    const data = buildReasoningProcessWireData(manyPhases(3_500, 6), "0.4.0");
    expect(data!.phases.length).toBeGreaterThan(1);
    expect(totalRunes(data)).toBeLessThanOrEqual(6_000);
  });

  it("spends the budget on the newest phases, shrinking the oldest first", () => {
    const data = buildReasoningProcessWireData(manyPhases(3_500, 6), "0.4.0");
    const lengths = data!.phases.map((phase) => [...phase.thought].length);
    // 最后一个 phase 是当前正在发生的,必须比第一个留得多。
    expect(lengths.at(-1)!).toBeGreaterThan(lengths[0]!);
    // 每个 phase 仍满足契约的 minLength: 1。
    expect(lengths.every((n) => n >= 1)).toBe(true);
  });

  it("leaves a single phase alone when it fits", () => {
    const data = buildReasoningProcessWireData(manyPhases(500, 1), "0.4.0");
    expect([...data!.phases[0]!.thought].length).toBe(500);
  });

  it("fits the actual template payload into the advertised UTF-8 byte limit", () => {
    const templateRef = { id: "ai.reasoning-process", version: "0.4.0" };
    const maxPayloadBytes = 16_384;
    const data = buildReasoningProcessWireData(
      manyPhases(3_500, 6, "界"),
      templateRef.version,
      { templateRef, maxPayloadBytes },
    );

    expect(data).not.toBeNull();
    const payload = {
      type: 17,
      template_ref: templateRef,
      state: data!.state,
      data,
    };
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength)
      .toBeLessThanOrEqual(maxPayloadBytes);
    expect([...data!.phases.at(-1)!.thought].length)
      .toBeGreaterThan([...data!.phases[0]!.thought].length);
  });
});
