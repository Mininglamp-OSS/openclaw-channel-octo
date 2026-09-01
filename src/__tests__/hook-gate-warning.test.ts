import { describe, it, expect } from "vitest";
import { _buildHookGateWarning } from "../../index.js";

/**
 * OpenClaw 2026.8 hook gating, per the host's own resolvers
 * (dist/hook-policy-decisions, verified against 2026.8.1):
 *
 *   resolvePromptInjectionAllowed(policy)
 *     = policy?.allowPromptInjection !== false
 *   resolveConversationAccessAllowed(origin, policy)
 *     = origin === "bundled" ? policy?.allowConversationAccess !== false
 *                            : policy?.allowConversationAccess === true
 *
 * So for a non-bundled plugin (anything installed from ClawHub, this one
 * included):
 *
 *   allowConversationAccess — must be EXPLICITLY true. Left unset, the host
 *     blocks the typed hooks, and its log names this key for every one of them,
 *     `before_prompt_build` included.
 *   allowPromptInjection — allowed by default. ONLY an explicit `false` turns
 *     prompt mutation off; an unset key is not a problem and must not be
 *     reported as one.
 *
 * Getting this backwards produces a warning that fires forever on a correctly
 * configured deployment, which trains operators to ignore the warning.
 */
describe("2026.8 hook gate — operator warning", () => {
  const withHooks = (hooks: unknown) => ({
    plugins: { entries: { octo: { hooks } } },
  });

  it("stays silent when allowConversationAccess is granted and promptInjection is left unset", () => {
    // The correctly-configured minimum: unset allowPromptInjection defaults to
    // allowed, so there is nothing to report.
    expect(_buildHookGateWarning(withHooks({ allowConversationAccess: true }))).toBeUndefined();
  });

  it("stays silent when both are explicitly granted", () => {
    expect(
      _buildHookGateWarning(
        withHooks({ allowConversationAccess: true, allowPromptInjection: true }),
      ),
    ).toBeUndefined();
  });

  it("blames the missing allowConversationAccess for the dropped context and persona", () => {
    const w = _buildHookGateWarning(withHooks({}));
    expect(w).toBeDefined();
    expect(w).toContain("allowConversationAccess");
    // the consequence, not just the key
    expect(w).toMatch(/persona/i);
    expect(w!.toLowerCase()).toMatch(/group (context|md|roster)|member list/);
    // an operator must be able to act on it
    expect(w).toContain("plugins.entries.octo.hooks");
    // an unset allowPromptInjection is fine — never name it as missing
    expect(w).not.toContain("allowPromptInjection");
  });

  it("reports an explicitly disabled allowPromptInjection on its own", () => {
    const w = _buildHookGateWarning(
      withHooks({ allowConversationAccess: true, allowPromptInjection: false }),
    );
    expect(w).toBeDefined();
    expect(w).toContain("allowPromptInjection");
    // conversation access is granted here, so it must not be reported
    expect(w).not.toContain("allowConversationAccess");
  });

  it("reports both when conversation access is missing and prompt injection is off", () => {
    const w = _buildHookGateWarning(withHooks({ allowPromptInjection: false }));
    expect(w).toBeDefined();
    expect(w).toContain("allowConversationAccess");
    expect(w).toContain("allowPromptInjection");
  });

  it("treats an explicit allowConversationAccess:false as not granted", () => {
    const w = _buildHookGateWarning(withHooks({ allowConversationAccess: false }));
    expect(w).toBeDefined();
    expect(w).toContain("allowConversationAccess");
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
      expect(() => _buildHookGateWarning(bad as never)).not.toThrow();
    }
  });

  it("warns when config is unreadable, since the required opt-in cannot be proven", () => {
    expect(_buildHookGateWarning(undefined as never)).toBeDefined();
    expect(_buildHookGateWarning({} as never)).toBeDefined();
  });
});
