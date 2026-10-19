import { afterEach, expect, it, vi } from "vitest";
import { handleInboundMessage } from "./inbound.js";
import { _resetOctoRuntimeForTests } from "./runtime.js";
import { ChannelType, MessageType } from "./types.js";

afterEach(() => { vi.unstubAllGlobals(); _resetOctoRuntimeForTests(); });

it("names a missing runtime and drop reason, and preserves the rejected dispatch", async () => {
  _resetOctoRuntimeForTests();
  const network = vi.fn(() => { throw new Error("unexpected network request"); });
  vi.stubGlobal("fetch", network);
  const error = vi.fn();
  await expect(handleInboundMessage({
    account: { accountId: "scope-test", enabled: true, configured: true,
      config: { apiUrl: "http://synthetic.invalid", botToken: "test-only" } } as never,
    botUid: "synthetic-bot",
    message: { message_id: "runtime-missing", message_seq: 1, from_uid: "synthetic-user",
      channel_id: "synthetic-user", channel_type: ChannelType.DM, timestamp: 1,
      payload: { type: MessageType.Text, content: "hello" } },
    groupHistories: new Map(), lastBotReplySeqMap: new Map(), memberMap: new Map(),
    uidToNameMap: new Map(), groupCacheTimestamps: new Map(), log: { error },
  })).rejects.toThrow("Octo runtime not initialized");
  expect(error).toHaveBeenCalledWith(expect.stringMatching(
    /inbound dropped account=scope-test .*reason=runtime-unavailable: Octo runtime not initialized; no Agent dispatch attempted/,
  ));
  expect(network).not.toHaveBeenCalled();
});
