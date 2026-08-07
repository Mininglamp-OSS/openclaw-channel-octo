import { describe, expect, it } from "vitest";
import { buildReasoningProcessWireData } from "./reasoning-process.js";
import { HOST_NO_SUMMARY_PLACEHOLDER } from "./reasoning-process.js";
import type { CardProgressState } from "./card-render.js";

/**
 * Wire-contract conformance for the `ai.reasoning-process` template data.
 *
 * The server validates caller data against the template's `contract/data.schema.json` on every
 * send and returns a deterministic 400 on a miss; a 4xx sets `entry.skip`, so the card disappears
 * for the rest of the session. After #204 the template path is the only producer of reasoning
 * phases — `renderReasoningProcessCard` has no production caller — so a schema violation is a
 * total loss of the feature, not a degraded render.
 *
 * The constraints below are transcribed from
 * `octo-card-forge/cards/ai.reasoning-process/contract/data.schema.json`. They are asserted here
 * rather than left implicit because a green unit suite otherwise says nothing about wire validity:
 * an earlier revision of this branch emitted `thought: ""` on three paths and every test passed.
 *
 * Keep in sync when the server publishes a new template version. `thought.maxLength` is
 * deliberately *not* asserted: the published versions checked did not constrain it, and the server
 * is raising the bound — see THOUGHT_MAX in reasoning-process.ts for why the producer value is
 * nonetheless coupled to it.
 */
const REQUIRED_TOP_LEVEL = [
  "reasoningId", "state", "title", "statusLabel", "statusTone",
  "timerText", "traceExpanded", "traceCollapsed", "collapsedSummary", "phases",
] as const;

function state(steps: CardProgressState["steps"], phase: CardProgressState["phase"] = "tool"): CardProgressState {
  return { reasoningId: "agent:main:octo:group:g1", phase, elapsedMs: 5_000, steps };
}

function expectContractValid(data: ReturnType<typeof buildReasoningProcessWireData>): void {
  expect(data).not.toBeNull();
  for (const key of REQUIRED_TOP_LEVEL) expect(data).toHaveProperty(key);
  // phases: minItems 1
  expect(data!.phases.length).toBeGreaterThanOrEqual(1);
  for (const phase of data!.phases) {
    // phase required: [thought, actions]; thought minLength 1
    expect(typeof phase.thought).toBe("string");
    expect(phase.thought.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(phase.actions)).toBe(true);
    for (const action of phase.actions) {
      expect(action.tool.length).toBeGreaterThanOrEqual(1);
      // statusGlyph is the one field the schema caps: maxLength 2.
      expect(action.statusGlyph.length).toBeGreaterThanOrEqual(1);
      expect(action.statusGlyph.length).toBeLessThanOrEqual(2);
    }
  }
}

describe("ai.reasoning-process wire data conforms to the template contract", () => {
  const tool = { tool: "exec", status: "done" as const, toolCallId: "t1", summary: "npm", resultSummary: "exit 0" };

  it.each([
    ["a captured thought", [{ tool: "__thinking__", status: "done" as const, modelCallId: "c1", thought: "核对输入。" }, tool]],
    // The dominant case on a default deployment: reasoningVisibility defaults to off, so no
    // reasoning text is ever captured and every thinking step arrives empty.
    ["a thinking step with no captured text", [{ tool: "__thinking__", status: "done" as const, modelCallId: "c1" }, tool]],
    ["a tool call with no preceding model call", [tool]],
    ["a thought the guard withheld", [{ tool: "__thinking__", status: "done" as const, modelCallId: "c1", thought: "Authorization: Bearer abcdefghijklmnop" }, tool]],
    ["a signed reasoning block with no summary", [{ tool: "__thinking__", status: "done" as const, modelCallId: "c1", thought: HOST_NO_SUMMARY_PLACEHOLDER }, tool]],
    ["a thought longer than the render cap", [{ tool: "__thinking__", status: "done" as const, modelCallId: "c1", thought: "永" .repeat(1_800) }, tool]],
  ])("holds for %s", (_label, steps) => {
    expectContractValid(buildReasoningProcessWireData(state(steps as CardProgressState["steps"])));
  });

  it.each(["answering", "done", "stopped", "error", "expired"] as const)(
    "holds in the %s phase",
    (phase) => {
      expectContractValid(buildReasoningProcessWireData(state([
        { tool: "__thinking__", status: "done", modelCallId: "c1", thought: "核对输入。" },
        tool,
      ], phase)));
    },
  );

  it("still returns null when there is no displayable action at all", () => {
    // Not a contract violation: no frame is sent, so nothing is validated. Asserted so the
    // conformance fix above is not mistaken for "always emit a phase".
    expect(buildReasoningProcessWireData(state([
      { tool: "__thinking__", status: "running", modelCallId: "c1", thought: "正在计划。" },
    ]))).toBeNull();
  });
});
