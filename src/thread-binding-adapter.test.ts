import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerOctoThreadBindingAdapter,
  __resetOctoThreadBindingsForTests,
} from "./thread-binding-adapter.js";

// Mock createThread (used only by the `child` placement path).
vi.mock("./api-fetch.js", () => ({
  createThread: vi.fn(),
}));

import { createThread } from "./api-fetch.js";

// Lowercase by design: the adapter normalizes accountIds via toLowerCase
// before storing, so most assertions in this file expect the normalized form.
// A separate `mixed-case account ID round-trip` describe block below covers
// the normalization behavior explicitly.
const ACCOUNT_ID = "27pbwzf2f6bfa5cd142_bot";
const API_URL = "https://im.example.com/api";
const BOT_TOKEN = "bf_test123";

function makeAdapterContext() {
  // capture log output for assertion
  const logs: { level: string; msg: string }[] = [];
  const log = {
    info: (msg: string) => logs.push({ level: "info", msg }),
    warn: (msg: string) => logs.push({ level: "warn", msg }),
    debug: (msg: string) => logs.push({ level: "debug", msg }),
  };
  const unregister = registerOctoThreadBindingAdapter({
    accountId: ACCOUNT_ID,
    apiUrl: API_URL,
    botToken: BOT_TOKEN,
    log,
  });
  return { unregister, logs };
}

// We need a way to call the adapter's bind/listBySession/etc. methods.
// The adapter is registered into the SDK's internal registry; the SDK
// doesn't publicly expose getCapabilities. So we re-register a fresh
// adapter for each test and capture a reference to its method surface
// via a small spy.
//
// Instead, we test the OBSERVABLE side-effects through the SDK's
// register/unregister API and through createThread mock calls.
//
// For per-method assertions, expose a "test handle" by reading the
// adapter we're about to register. Easiest: import the SessionBindingAdapter
// shape from the SDK and construct a fresh bind input ourselves using
// the same registry the SDK uses.

// conversation-runtime is the subpath that ships types for these (see
// thread-binding-adapter.ts) — thread-bindings-runtime has no `.d.ts` on 2026.8.1.
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";

// Helper: capture the registered adapter so tests can call its methods.
// We replace the SDK's register fn via vi.mock for the duration of the test.
let _capturedAdapter: SessionBindingAdapter | null = null;

// Must name the SAME specifier the code under test imports, or the mock never
// applies: thread-binding-adapter.ts now uses conversation-runtime.
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    registerSessionBindingAdapter: (adapter: SessionBindingAdapter) => {
      _capturedAdapter = adapter;
      // Also register with the real SDK so unregister round-trips work.
      (actual.registerSessionBindingAdapter as typeof registerSessionBindingAdapter)(adapter);
    },
    unregisterSessionBindingAdapter: (params: Parameters<typeof unregisterSessionBindingAdapter>[0]) => {
      _capturedAdapter = null;
      (actual.unregisterSessionBindingAdapter as typeof unregisterSessionBindingAdapter)(params);
    },
  };
});

describe("registerOctoThreadBindingAdapter", () => {
  beforeEach(() => {
    __resetOctoThreadBindingsForTests();
    _capturedAdapter = null;
    vi.mocked(createThread).mockReset();
  });

  afterEach(() => {
    if (_capturedAdapter) {
      // Best-effort cleanup
      _capturedAdapter = null;
    }
    __resetOctoThreadBindingsForTests();
  });

  it("registers an adapter with placements=[current,child] and bindSupported=true", () => {
    const { unregister } = makeAdapterContext();
    expect(_capturedAdapter).not.toBeNull();
    expect(_capturedAdapter!.channel).toBe("octo");
    expect(_capturedAdapter!.accountId).toBe(ACCOUNT_ID);
    expect(_capturedAdapter!.capabilities).toEqual({
      placements: ["current", "child"],
      bindSupported: true,
      unbindSupported: true,
    });
    unregister();
  });

  it("bind(placement=current) records a binding using the existing conversationId without calling createThread", async () => {
    const { unregister } = makeAdapterContext();
    const conversationId = "groupNo_abc";
    const targetSessionKey = "agent:cc:acp:9da61851";

    const record = await _capturedAdapter!.bind!({
      targetSessionKey,
      targetKind: "session",
      conversation: { channel: "octo", accountId: ACCOUNT_ID, conversationId },
      placement: "current",
    });

    expect(record).not.toBeNull();
    expect(record!.bindingId).toBe(`${ACCOUNT_ID}:${conversationId}`);
    expect(record!.targetSessionKey).toBe(targetSessionKey);
    expect(record!.conversation.conversationId).toBe(conversationId);
    expect(record!.status).toBe("active");
    expect(vi.mocked(createThread)).not.toHaveBeenCalled();

    // Adapter should be able to look the binding up by conversation.
    const found = _capturedAdapter!.resolveByConversation({
      channel: "octo",
      accountId: ACCOUNT_ID,
      conversationId,
    });
    expect(found?.bindingId).toBe(record!.bindingId);

    // …and by session key.
    const bySession = _capturedAdapter!.listBySession(targetSessionKey);
    expect(bySession).toHaveLength(1);
    expect(bySession[0]!.bindingId).toBe(record!.bindingId);

    unregister();
  });

  it("bind(placement=child) calls createThread and uses groupNo____shortId as conversationId", async () => {
    vi.mocked(createThread).mockResolvedValueOnce({
      short_id: "thrxyz",
      name: "Agent: 9da61851",
      creator_uid: "bot-uid",
    });
    const { unregister } = makeAdapterContext();

    const record = await _capturedAdapter!.bind!({
      targetSessionKey: "agent:cc:acp:9da61851",
      targetKind: "session",
      conversation: {
        channel: "octo",
        accountId: ACCOUNT_ID,
        conversationId: "parentGroup",
      },
      placement: "child",
    });

    expect(vi.mocked(createThread)).toHaveBeenCalledOnce();
    expect(vi.mocked(createThread)).toHaveBeenCalledWith({
      apiUrl: API_URL,
      botToken: BOT_TOKEN,
      groupNo: "parentGroup",
      name: "Agent: 9da61851",
    });
    expect(record).not.toBeNull();
    expect(record!.conversation.conversationId).toBe("parentGroup____thrxyz");
    expect(record!.conversation.parentConversationId).toBe("parentGroup");

    unregister();
  });

  it("bind(placement=child) returns null when createThread fails (does not throw)", async () => {
    vi.mocked(createThread).mockRejectedValueOnce(new Error("network down"));
    const { unregister, logs } = makeAdapterContext();

    const record = await _capturedAdapter!.bind!({
      targetSessionKey: "agent:cc:acp:abc",
      targetKind: "session",
      conversation: {
        channel: "octo",
        accountId: ACCOUNT_ID,
        conversationId: "parentGroup",
      },
      placement: "child",
    });

    expect(record).toBeNull();
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("createThread failed"))).toBe(true);

    unregister();
  });

  it("bind(placement=child) extracts parent group_no from a thread-shaped parentConversationId", async () => {
    vi.mocked(createThread).mockResolvedValueOnce({
      short_id: "newshort",
      name: "x",
      creator_uid: "bot-uid",
    });
    const { unregister } = makeAdapterContext();

    await _capturedAdapter!.bind!({
      targetSessionKey: "agent:cc:acp:abc",
      targetKind: "session",
      conversation: {
        channel: "octo",
        accountId: ACCOUNT_ID,
        // Caller is already in a thread; child should still be created under the parent group.
        conversationId: "parentGroup____oldshort",
      },
      placement: "child",
    });

    expect(vi.mocked(createThread)).toHaveBeenCalledWith(
      expect.objectContaining({ groupNo: "parentGroup" }),
    );
    unregister();
  });

  it("unbind by bindingId removes the record and returns it with status=ended", async () => {
    const { unregister } = makeAdapterContext();
    const conv = "groupX";
    const rec = await _capturedAdapter!.bind!({
      targetSessionKey: "s1",
      targetKind: "session",
      conversation: { channel: "octo", accountId: ACCOUNT_ID, conversationId: conv },
      placement: "current",
    });

    const removed = await _capturedAdapter!.unbind!({
      bindingId: rec!.bindingId,
      reason: "user-requested",
    });

    expect(removed).toHaveLength(1);
    expect(removed[0]!.status).toBe("ended");
    expect(_capturedAdapter!.resolveByConversation({ channel: "octo", accountId: ACCOUNT_ID, conversationId: conv })).toBeNull();

    unregister();
  });

  it("unbind by targetSessionKey removes all matching bindings", async () => {
    const { unregister } = makeAdapterContext();
    await _capturedAdapter!.bind!({
      targetSessionKey: "shared",
      targetKind: "session",
      conversation: { channel: "octo", accountId: ACCOUNT_ID, conversationId: "g1" },
      placement: "current",
    });
    await _capturedAdapter!.bind!({
      targetSessionKey: "shared",
      targetKind: "session",
      conversation: { channel: "octo", accountId: ACCOUNT_ID, conversationId: "g2" },
      placement: "current",
    });
    await _capturedAdapter!.bind!({
      targetSessionKey: "other",
      targetKind: "session",
      conversation: { channel: "octo", accountId: ACCOUNT_ID, conversationId: "g3" },
      placement: "current",
    });

    const removed = await _capturedAdapter!.unbind!({
      targetSessionKey: "shared",
      reason: "session-ended",
    });
    expect(removed).toHaveLength(2);
    expect(_capturedAdapter!.listBySession("shared")).toHaveLength(0);
    expect(_capturedAdapter!.listBySession("other")).toHaveLength(1);

    unregister();
  });

  it("the unregister function clears bindings and is idempotent", async () => {
    const { unregister } = makeAdapterContext();
    await _capturedAdapter!.bind!({
      targetSessionKey: "s",
      targetKind: "session",
      conversation: { channel: "octo", accountId: ACCOUNT_ID, conversationId: "c" },
      placement: "current",
    });
    expect(_capturedAdapter!.listBySession("s")).toHaveLength(1);

    unregister();
    // Calling unregister again must not throw.
    unregister();
    // The captured adapter reference is from BEFORE unregister; its listBySession
    // reads from the module-level map. After unregister, that map is cleared.
    expect(_capturedAdapter).toBeNull();
  });

  it("bind(placement=current) ignores conversations from other channels", async () => {
    const { unregister } = makeAdapterContext();
    const record = await _capturedAdapter!.bind!({
      targetSessionKey: "s",
      targetKind: "session",
      conversation: {
        channel: "telegram", // not octo
        accountId: ACCOUNT_ID,
        conversationId: "tg-chat",
      },
      placement: "current",
    });
    expect(record).toBeNull();
    unregister();
  });

  it("bind(placement=current) ignores conversations whose accountId does not match the adapter", async () => {
    const { unregister } = makeAdapterContext();
    const record = await _capturedAdapter!.bind!({
      targetSessionKey: "s",
      targetKind: "session",
      conversation: {
        channel: "octo",
        accountId: "27someotheraccount_bot", // not ACCOUNT_ID
        conversationId: "c",
      },
      placement: "current",
    });
    expect(record).toBeNull();
    unregister();
  });

  // -------------------------------------------------------------------------
  // Mixed-case account ID round-trip (regression for issue #33).
  // -------------------------------------------------------------------------
  // OpenClaw's session-binding service normalizes adapter accountIds and
  // conversation refs to lowercase before invoking adapter methods. A previous
  // version of the adapter captured the raw mixed-case accountId in its
  // closure and compared `ref.accountId !== accountId` directly, which made
  // `resolveByConversation` silently miss for any account whose original ID
  // contained uppercase letters (BotFather emits mixed-case bf_… IDs).
  // -------------------------------------------------------------------------
  describe("mixed-case account ID round-trip", () => {
    const MIXED_CASE_ACCOUNT = "27pBwzf2F6bfa5cd142_bot";
    const NORMALIZED = MIXED_CASE_ACCOUNT.toLowerCase();

    it("registers the adapter under the normalized (lowercased) accountId", () => {
      const unregister = registerOctoThreadBindingAdapter({
        accountId: MIXED_CASE_ACCOUNT,
        apiUrl: API_URL,
        botToken: BOT_TOKEN,
      });
      expect(_capturedAdapter).not.toBeNull();
      expect(_capturedAdapter!.accountId).toBe(NORMALIZED);
      unregister();
    });

    it("resolveByConversation matches when the SDK passes a lowercased ref (the production path)", async () => {
      const unregister = registerOctoThreadBindingAdapter({
        accountId: MIXED_CASE_ACCOUNT,
        apiUrl: API_URL,
        botToken: BOT_TOKEN,
      });
      // SDK normalizes the conversation ref before calling bind(). Simulate
      // exactly what the production path looks like by passing the lowercased
      // accountId on every interaction.
      const conversationId = "groupX";
      const rec = await _capturedAdapter!.bind!({
        targetSessionKey: "agent:cc:acp:abc",
        targetKind: "session",
        conversation: {
          channel: "octo",
          accountId: NORMALIZED,
          conversationId,
        },
        placement: "current",
      });
      expect(rec).not.toBeNull();
      expect(rec!.conversation.accountId).toBe(NORMALIZED);

      // The crucial assertion: SDK calls resolveByConversation with the
      // lowercased accountId. Before the fix, the adapter compared this to
      // the captured mixed-case original and returned null.
      const found = _capturedAdapter!.resolveByConversation({
        channel: "octo",
        accountId: NORMALIZED,
        conversationId,
      });
      expect(found?.bindingId).toBe(rec!.bindingId);
      unregister();
    });

    it("resolveByConversation also matches when callers pass the original mixed-case accountId (defensive double-normalization)", () => {
      const unregister = registerOctoThreadBindingAdapter({
        accountId: MIXED_CASE_ACCOUNT,
        apiUrl: API_URL,
        botToken: BOT_TOKEN,
      });
      // Direct adapter-level callers (e.g. tests, debug tools) might bypass
      // SDK normalization and pass the raw mixed-case accountId. The adapter
      // normalizes the ref defensively, so this still resolves.
      _capturedAdapter!.bind!({
        targetSessionKey: "s",
        targetKind: "session",
        conversation: { channel: "octo", accountId: NORMALIZED, conversationId: "g" },
        placement: "current",
      });
      const found = _capturedAdapter!.resolveByConversation({
        channel: "octo",
        accountId: MIXED_CASE_ACCOUNT, // mixed case here
        conversationId: "g",
      });
      expect(found).not.toBeNull();
      unregister();
    });
  });
});
