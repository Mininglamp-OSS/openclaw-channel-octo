import { describe, it, expect } from "vitest";
import { _buildHookGateWarning } from "../../index.js";

/**
 * OpenClaw 2026.8 gates typed hooks for non-bundled plugins behind two
 * explicit config opt-ins:
 *
 *   plugins.entries.octo.hooks.allowPromptInjection    -> before_prompt_build
 *   plugins.entries.octo.hooks.allowConversationAccess -> before_agent_run,
 *                                                         llm_output, agent_end
 *
 * A plugin cannot grant itself these (by design — the user must consent in
 * their own config), so the only thing we can do is tell the operator loudly.
 *
 * This matters because the failure is SILENT: the bot still answers, it just
 * loses the group roster, the group MD and — for persona clones — its own
 * identity, so it drops out of character. Without a warning that names the
 * consequence, an operator reads the stock host message as harmless noise.
 */
describe("2026.8 hook gate — operator warning", () => {
  const withHooks = (hooks: unknown) => ({
    plugins: { entries: { octo: { hooks } } },
  });

  it("stays silent when both opt-ins are granted", () => {
    const w = _buildHookGateWarning(
      withHooks({ allowPromptInjection: true, allowConversationAccess: true }),
    );
    expect(w).toBeUndefined();
  });

  it("names allowPromptInjection and the context/persona it silently drops", () => {
    const w = _buildHookGateWarning(withHooks({ allowConversationAccess: true }));
    expect(w).toBeDefined();
    expect(w).toContain("allowPromptInjection");
    // must state the consequence, not just the missing key
    expect(w).toMatch(/persona/i);
    expect(w!.toLowerCase()).toMatch(/group (context|md|roster)|member list/);
    // the granted one must NOT be reported as missing
    expect(w).not.toContain("allowConversationAccess");
  });

  it("names allowConversationAccess when only that one is missing", () => {
    const w = _buildHookGateWarning(withHooks({ allowPromptInjection: true }));
    expect(w).toBeDefined();
    expect(w).toContain("allowConversationAccess");
    expect(w).not.toContain("allowPromptInjection");
  });

  it("reports both when neither is granted, and shows where to set them", () => {
    const w = _buildHookGateWarning(withHooks({}));
    expect(w).toBeDefined();
    expect(w).toContain("allowPromptInjection");
    expect(w).toContain("allowConversationAccess");
    // an operator must be able to act on it: name the config path
    expect(w).toContain("plugins.entries.octo.hooks");
  });

  it("treats an explicit false the same as missing", () => {
    const w = _buildHookGateWarning(
      withHooks({ allowPromptInjection: false, allowConversationAccess: false }),
    );
    expect(w).toBeDefined();
    expect(w).toContain("allowPromptInjection");
    expect(w).toContain("allowConversationAccess");
  });

  it("never throws on absent or malformed config", () => {
    // Reading config must never be able to take the plugin's registration down.
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

  it("warns (rather than staying silent) when config is unreadable", () => {
    // If we cannot prove the opt-ins are granted, the safer default is to warn:
    // a spurious warning costs a log line, a missed one costs silent degradation.
    expect(_buildHookGateWarning(undefined as never)).toBeDefined();
    expect(_buildHookGateWarning({} as never)).toBeDefined();
  });
});
