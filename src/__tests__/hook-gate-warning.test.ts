import { describe, it, expect } from "vitest";
import { _buildHookGateWarning } from "../../index.js";

/**
 * OpenClaw's non-bundled hook opt-in, as actually shipped.
 *
 * The gate is NOT new in 2026.8. It exists at the declared peer floor already —
 * openclaw@2026.6.9 inlines it in `dist/registry-*.js`:
 *
 *   if (isConversationHookName(effectiveHookName)) {
 *     const explicitConversationAccess = policy?.allowConversationAccess;
 *     if (record.origin !== "bundled" && explicitConversationAccess !== true) {
 *       pushDiagnostic({ ... "blocked because non-bundled plugins must set
 *                        plugins.entries.<id>.hooks.allowConversationAccess=true" });
 *       return;   // the hook is not registered
 *     }
 *
 * 2026.8 only extracted that into a named `resolveConversationAccessAllowed`
 * helper and WIDENED the gated set. `conversationHookNameSet`:
 *
 *   2026.6.9 (7): before_model_resolve, before_agent_reply, llm_input,
 *                 llm_output, before_agent_finalize, agent_end, before_agent_run
 *   2026.8.1 (9): the same, plus agent_turn_prepare and before_prompt_build
 *
 * Of this plugin's nine hook registrations, that means:
 *
 *   every supported host — agent_end, before_agent_run, llm_output are gated,
 *     so interactive card progress degrades (run binding, streaming, finalization)
 *   2026.8+ additionally — before_prompt_build is gated, so group MD, the member
 *     list and persona identity stop reaching the prompt
 *
 * Hence the warning must fire on EVERY supported host; only its description of
 * the consequences varies by version. Suppressing it below 2026.8 would silence a
 * true positive across the lower half of the supported peer range.
 *
 * The second key, allowPromptInjection, is asymmetric and default-allowed
 * (`!== false`): only an explicit false disables prompt mutation, so an unset key
 * must never be reported as a problem.
 */
describe("non-bundled hook opt-in — operator warning", () => {
  const withHooks = (hooks: unknown) => ({
    plugins: { entries: { octo: { hooks } } },
  });
  const V_OLD = "2026.6.9";
  const V_MID = "2026.7.2";
  const V_NEW = "2026.8.1";

  it("stays silent when allowConversationAccess is granted, on every host", () => {
    for (const v of [V_OLD, V_MID, V_NEW, undefined]) {
      expect(
        _buildHookGateWarning(withHooks({ allowConversationAccess: true }), v as never),
        `host ${String(v)}`,
      ).toBeUndefined();
    }
  });

  it("stays silent when both keys are explicitly granted", () => {
    expect(
      _buildHookGateWarning(
        withHooks({ allowConversationAccess: true, allowPromptInjection: true }),
        V_NEW,
      ),
    ).toBeUndefined();
  });

  it("warns on hosts at the peer floor, where card-progress hooks are already gated", () => {
    // Regression guard: an earlier version suppressed this below 2026.8 on the
    // false premise that older hosts do not gate. They do.
    for (const v of [V_OLD, V_MID]) {
      const w = _buildHookGateWarning(withHooks({}), v);
      expect(w, `host ${v}`).toBeDefined();
      expect(w).toContain("allowConversationAccess");
      // names the hooks this host actually blocks
      expect(w).toContain("before_agent_run");
      expect(w!.toLowerCase()).toMatch(/card progress|card-progress/);
      // must NOT claim group context / persona are lost — not gated on these
      // hosts. Saying they still work is correct and useful; claiming they broke
      // would be the false positive.
      expect(w!.toLowerCase()).toContain("still work");
      expect(w).not.toMatch(/never reach the prompt|out of character/i);
    }
  });

  it("warns on 2026.8+ and adds the group-context and persona consequence", () => {
    const w = _buildHookGateWarning(withHooks({}), V_NEW);
    expect(w).toBeDefined();
    expect(w).toContain("allowConversationAccess");
    expect(w).toContain("before_prompt_build");
    expect(w).toMatch(/persona/i);
    expect(w!.toLowerCase()).toMatch(/group (context|md|roster)|member list/);
    // still names the hooks gated on every host
    expect(w).toContain("before_agent_run");
  });

  it("does not overstate the blast radius as every typed hook", () => {
    // The host gates conversation hooks only; five of this plugin's nine
    // registrations (before_reset, before_tool_call, after_tool_call,
    // model_call_started, model_call_ended) are never affected.
    for (const v of [V_OLD, V_NEW]) {
      const w = _buildHookGateWarning(withHooks({}), v)!;
      expect(w.toLowerCase()).not.toContain("every typed hook");
      expect(w.toLowerCase()).toContain("conversation hook");
    }
  });

  it("points at the config path an operator has to edit", () => {
    expect(_buildHookGateWarning(withHooks({}), V_NEW)).toContain(
      "plugins.entries.octo.hooks",
    );
  });

  it("reports an explicitly disabled allowPromptInjection on its own", () => {
    const w = _buildHookGateWarning(
      withHooks({ allowConversationAccess: true, allowPromptInjection: false }),
      V_NEW,
    );
    expect(w).toBeDefined();
    expect(w).toContain("allowPromptInjection");
    expect(w).not.toContain("allowConversationAccess");
  });

  it("reports both when conversation access is missing and prompt injection is off", () => {
    const w = _buildHookGateWarning(withHooks({ allowPromptInjection: false }), V_NEW);
    expect(w).toBeDefined();
    expect(w).toContain("allowConversationAccess");
    expect(w).toContain("allowPromptInjection");
  });

  it("treats an explicit allowConversationAccess:false as not granted", () => {
    const w = _buildHookGateWarning(withHooks({ allowConversationAccess: false }), V_NEW);
    expect(w).toBeDefined();
    expect(w).toContain("allowConversationAccess");
  });

  it("assumes the wider 2026.8 gate when the host version is unknown", () => {
    // Cannot prove the host is older, so describe the worse case rather than
    // under-report it.
    for (const v of [undefined, "", "unknown", "dev"]) {
      const w = _buildHookGateWarning(withHooks({}), v as never);
      expect(w, `host ${String(v)}`).toBeDefined();
      expect(w).toContain("before_prompt_build");
    }
  });

  it("never throws on absent or malformed config", () => {
    for (const bad of [
      undefined,
      null,
      {},
      { plugins: null },
      { plugins: {} },
      { plugins: { entries: null } },
      { plugins: { entries: {} } },
      { plugins: { entries: { octo: null } } },
      { plugins: { entries: { octo: {} } } },
      { plugins: { entries: { octo: { hooks: null } } } },
      { plugins: { entries: { octo: { hooks: "nope" } } } },
      { plugins: "nope" },
    ]) {
      expect(() => _buildHookGateWarning(bad as never, V_NEW)).not.toThrow();
    }
  });

  it("warns when config is unreadable, since the required opt-in cannot be proven", () => {
    expect(_buildHookGateWarning(undefined as never, V_NEW)).toBeDefined();
    expect(_buildHookGateWarning({} as never, V_NEW)).toBeDefined();
  });
});
