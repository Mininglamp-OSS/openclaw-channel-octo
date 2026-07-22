/**
 * Regression tests for #171: handleAction must return a valid AgentToolResult
 * ({ content: [...], details }) on every return path, so the OpenClaw host's
 * Codex tool-result conversion (convertToolContents → content.reduce, no
 * Array.isArray guard) does not throw "Cannot read properties of undefined
 * (reading 'reduce')" after a send succeeds.
 *
 * Exceptions are intentionally NOT wrapped: the host wraps tool execution in
 * its own try/catch (failedToolResult) and relies on the throw for the
 * after-tool-call error hook + failed-idempotency-key retention. handleAction
 * must let exceptions propagate — test 6 locks that contract in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

// Only override handleOctoMessageAction; keep the rest of actions.js real so
// channel.ts's other handlers (which import parseTarget/resolveOutboundOctoTarget
// etc. from the same module) still load correctly.
vi.mock("./actions.js", async (importActual) => {
  const actual = await importActual<typeof import("./actions.js")>();
  return { ...actual, handleOctoMessageAction: vi.fn() };
});

type ToolResult = {
  content: { type: string; text: string }[];
  details: { ok: boolean; data?: unknown; error?: string };
};

// cfg whose resolved account HAS a botToken → reaches the delegated path.
function cfgWithToken() {
  return {
    channels: {
      octo: { accounts: { default: { botToken: "tok", apiUrl: "http://api" } } },
    },
  };
}

// cfg whose resolved account has NO botToken → config-error branch.
function cfgWithoutToken() {
  return {
    channels: {
      octo: { accounts: { default: { apiUrl: "http://api" } } },
    },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "default",
    action: "send" as const,
    channel: "octo",
    params: { target: "user:u1", text: "hi" },
    // No currentChannelId → skip the accountId-correction branch.
    toolContext: {},
    cfg: cfgWithToken(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// Mirror of the host's unguarded aggregation (convertToolContents in
// openclaw dist provider-capabilities-*.js): if content is not an array this
// throws — the exact bug #171 fixes. Kept in sync manually with the SDK.
function hostReduce(content: unknown): number {
  return (content as { type: string; text: string }[]).reduce(
    (total, item) => total + (item.type === "text" ? item.text.length : 0),
    0,
  );
}

// Mirror of the host's error classification (isToolResultError in openclaw
// dist embedded-agent-message-tool-source-reply-*.js) — it reads details.ok /
// details.error. Kept in sync manually with the SDK.
function hostIsToolResultError(result: ToolResult): boolean {
  const d = result.details;
  if (d?.ok === false) return true;
  if (d?.error) return true;
  return false;
}

describe("toActionToolResult (helper)", () => {
  it("wraps any payload into content[] + details, and host reduce does not throw", async () => {
    const { toActionToolResult } = await import("./channel.js");

    for (const payload of [
      { ok: true, data: { messageId: "m1" } },
      { ok: false, error: "boom" },
    ] as const) {
      const r = toActionToolResult(payload) as ToolResult;
      expect(Array.isArray(r.content)).toBe(true);
      expect(r.content[0]).toMatchObject({ type: "text" });
      expect(typeof r.content[0].text).toBe("string");
      expect(r.details).toEqual(payload);
      expect(() => hostReduce(r.content)).not.toThrow();
    }
  });

  it("never throws while building content, even on an unserializable payload", async () => {
    const { toActionToolResult } = await import("./channel.js");
    const circular: Record<string, unknown> = { ok: false, error: "boom" };
    circular.self = circular; // JSON.stringify would throw on this

    let r!: ToolResult;
    expect(() => {
      r = toActionToolResult(circular as any) as ToolResult;
    }).not.toThrow();
    expect(Array.isArray(r.content)).toBe(true);
    expect(typeof r.content[0].text).toBe("string");
    expect(() => hostReduce(r.content)).not.toThrow();
  });

  it("content.text is always a string, even when JSON.stringify returns undefined", async () => {
    const { toActionToolResult } = await import("./channel.js");
    // A root-level toJSON()→undefined makes JSON.stringify return undefined
    // WITHOUT throwing — the guard must still yield a string.
    const payload = { ok: true, toJSON: () => undefined };

    const r = toActionToolResult(payload as any) as ToolResult;

    expect(typeof r.content[0].text).toBe("string");
    expect(r.content[0].text.length).toBeGreaterThan(0);
    expect(() => hostReduce(r.content)).not.toThrow();
  });
});

describe("handleAction returns AgentToolResult (#171)", () => {
  it("success branch: content is an array and details preserves ok/data", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { handleOctoMessageAction } = await import("./actions.js");
    vi.mocked(handleOctoMessageAction).mockResolvedValue({
      ok: true,
      data: { messageId: "m1" },
    });

    const r = (await octoPlugin.actions!.handleAction!(makeCtx() as any)) as ToolResult;

    expect(Array.isArray(r.content)).toBe(true);
    expect(() => hostReduce(r.content)).not.toThrow();
    expect(r.details).toMatchObject({ ok: true, data: { messageId: "m1" } });
  });

  it("config-error branch (no botToken): valid AgentToolResult with details.ok=false", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { handleOctoMessageAction } = await import("./actions.js");

    const r = (await octoPlugin.actions!.handleAction!(
      makeCtx({ cfg: cfgWithoutToken() }) as any,
    )) as ToolResult;

    expect(Array.isArray(r.content)).toBe(true);
    expect(r.details.ok).toBe(false);
    expect(r.details.error).toMatch(/botToken/i);
    // config-error short-circuits before delegating.
    expect(handleOctoMessageAction).not.toHaveBeenCalled();
  });

  it("unknown-action branch: delegated error still wrapped as AgentToolResult", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { handleOctoMessageAction } = await import("./actions.js");
    vi.mocked(handleOctoMessageAction).mockResolvedValue({
      ok: false,
      error: "Unknown action: bogus",
    });

    const r = (await octoPlugin.actions!.handleAction!(
      makeCtx({ action: "bogus" }) as any,
    )) as ToolResult;

    expect(Array.isArray(r.content)).toBe(true);
    expect(() => hostReduce(r.content)).not.toThrow();
    expect(r.details.ok).toBe(false);
    expect(r.details.error).toMatch(/unknown action/i);
  });

  it("error classification: wrapper does not swallow errors nor mislabel success", async () => {
    const { toActionToolResult } = await import("./channel.js");

    expect(hostIsToolResultError(toActionToolResult({ ok: false, error: "x" }) as ToolResult)).toBe(true);
    expect(hostIsToolResultError(toActionToolResult({ ok: true, data: {} }) as ToolResult)).toBe(false);
  });

  it("exception propagates (not swallowed) so the host can handle it", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { handleOctoMessageAction } = await import("./actions.js");
    vi.mocked(handleOctoMessageAction).mockRejectedValue(new Error("network down"));

    await expect(
      octoPlugin.actions!.handleAction!(makeCtx() as any),
    ).rejects.toThrow("network down");
  });

  it("large payload is serialized compactly (no pretty-print indentation)", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { handleOctoMessageAction } = await import("./actions.js");
    const history = Array.from({ length: 50 }, (_, i) => ({ id: i, text: `msg ${i}` }));
    vi.mocked(handleOctoMessageAction).mockResolvedValue({ ok: true, data: { history } });

    const r = (await octoPlugin.actions!.handleAction!(makeCtx({ action: "read" }) as any)) as ToolResult;

    // Pretty-print (JSON.stringify(x, null, 2)) would insert "\n  "; compact must not.
    expect(r.content[0].text).not.toMatch(/\n {2}/);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true });
  });
});
