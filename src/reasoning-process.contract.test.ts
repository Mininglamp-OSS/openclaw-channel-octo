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
 * The constraints below are transcribed from the **handoff artifact the server actually serves**,
 * `octo-server/pkg/cardtmpl/ai_reasoning_process/handoff/ai.reasoning-process@0.3.0/contract/
 * data.schema.json` (0.4.0 raises only `thought`, to 4001 — see octo-server#712). An earlier
 * revision of this file cited a card-authoring repo instead and transcribed a superseded, unbounded
 * contract, which is how it managed to assert that `statusGlyph` was the only capped field. Every
 * string in the real contract is capped.
 *
 * They are asserted here because a green unit suite otherwise says nothing about wire validity: an
 * earlier revision of this branch emitted `thought: ""` on three paths and every test passed.
 *
 * WHAT THIS DOES NOT VALIDATE: the real schema also uses `allOf`, `if`/`then`, `oneOf`, `const`,
 * `enum`, `additionalProperties` and a custom `x-octo-constraints` (`aggregateArrayLimits` /
 * `maxTotalItems`). Only length and cardinality are checked here — that is where every violation
 * found so far has been, but do not read a pass as full conformance. A vendored schema plus a real
 * validator would be strictly better; it needs a new dependency, so it is out of scope here.
 *
 * Keep in sync when the server publishes a new template version.
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
  // 顶层字符串上限,取自同一份 handoff schema。
  const runes = (v: string): number => [...v].length;
  expect(runes(data!.reasoningId)).toBeLessThanOrEqual(512);
  expect(runes(data!.title)).toBeLessThanOrEqual(64);
  expect(runes(data!.statusLabel)).toBeLessThanOrEqual(32);
  expect(runes(data!.timerText)).toBeLessThanOrEqual(128);
  expect(runes(data!.collapsedSummary)).toBeLessThanOrEqual(160);
  if (data!.progressText !== undefined) expect(runes(data!.progressText)).toBeLessThanOrEqual(160);
  if (data!.errorTitle !== undefined) expect(runes(data!.errorTitle)).toBeLessThanOrEqual(64);
  if (data!.errorMessage !== undefined) expect(runes(data!.errorMessage)).toBeLessThanOrEqual(121);
  // phases: minItems 1, maxItems 6
  expect(data!.phases.length).toBeGreaterThanOrEqual(1);
  expect(data!.phases.length).toBeLessThanOrEqual(6);
  for (const phase of data!.phases) {
    // phase required: [thought, actions]; thought minLength 1
    expect(typeof phase.thought).toBe("string");
    expect([...phase.thought].length).toBeGreaterThanOrEqual(1);
    expect([...phase.thought].length).toBeLessThanOrEqual(281);
    expect(Array.isArray(phase.actions)).toBe(true);
    expect(phase.actions.length).toBeGreaterThanOrEqual(1);
    expect(phase.actions.length).toBeLessThanOrEqual(12);
    for (const action of phase.actions) {
      expect(action.tool.length).toBeGreaterThanOrEqual(1);
      expect([...action.tool].length).toBeLessThanOrEqual(81);
      expect([...action.detail].length).toBeGreaterThanOrEqual(1);
      expect([...action.detail].length).toBeLessThanOrEqual(192);
      // statusGlyph: maxLength 2 (every string in the contract is capped; these are the ones this
      // producer emits).
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
