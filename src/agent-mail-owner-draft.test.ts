import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearOwnerDraftConfirmations,
  createOwnerDraftDeliveryCapability,
  recordOwnerDraftConfirmation,
} from "./agent-mail-owner-draft.js";
import { ChannelType, MessageType, type BotMessage } from "./types.js";

afterEach(() => {
  clearOwnerDraftConfirmations();
  vi.restoreAllMocks();
});

function message(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    message_id: "msg-1",
    message_seq: 1,
    from_uid: "owner-1",
    channel_id: "sspace-1_owner-1@sspace-1_bot-1",
    channel_type: ChannelType.DM,
    timestamp: Math.floor(Date.now() / 1_000),
    payload: { type: MessageType.Text, content: "确认发送" },
    ...overrides,
  };
}

describe("OCTO Agent Mail owner Draft capability", () => {
  it("consumes one exact Owner DM and sends only through the Bot gateway", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer bf_secret",
        "X-Space-ID": "space-1",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ mailboxId: "42", draftVersion: 3 });
      return new Response(JSON.stringify({
        outcome: "accepted",
        messageId: "mail-1",
        submissionIds: [7],
        senderAddress: "bot@mail.imocto.cn",
      }), { status: 200 });
    });
    const capability = createCapability(fetchMock);
    const request = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };
    capability.prepareOwnerDraft(request);
    expect(recordOwnerDraftConfirmation({
      accountId: "Bot-1",
      sessionKey: request.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message(),
    })).toBe(true);
    await expect(capability.sendOwnerDraft(request)).resolves.toEqual({
      outcome: "accepted",
      messageId: "mail-1",
      submissionIds: ["7"],
      senderAddress: "bot@mail.imocto.cn",
    });
    await expect(capability.sendOwnerDraft(request)).rejects.toThrow("No matching exact");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not grant a replay of a confirmation rejected before preparation", () => {
    const capability = createCapability(vi.fn());
    const confirmation = {
      accountId: "bot-1",
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message(),
    };
    const request = {
      sessionKey: confirmation.sessionKey,
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };

    expect(recordOwnerDraftConfirmation(confirmation)).toBe(false);
    capability.prepareOwnerDraft(request);
    expect(recordOwnerDraftConfirmation(confirmation)).toBe(false);
    expect(recordOwnerDraftConfirmation({
      ...confirmation,
      message: message({ message_id: "msg-new-after-prepare" }),
    })).toBe(true);
  });

  it("rejects replacing a prepared Draft and preserves the original confirmation binding", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/drafts/E17/send");
      expect(JSON.parse(String(init?.body))).toEqual({ mailboxId: "42", draftVersion: 3 });
      return new Response(JSON.stringify({
        outcome: "accepted",
        messageId: "mail-original",
        submissionIds: ["submission-original"],
      }), { status: 200 });
    });
    const capability = createCapability(fetchMock);
    const original = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };
    const replacement = {
      ...original,
      draftId: "E99",
      draftVersion: 4,
    };

    capability.prepareOwnerDraft(original);
    expect(() => capability.prepareOwnerDraft(replacement)).toThrow("different mail Draft");
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: original.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message({ message_id: "msg-original-draft" }),
    })).toBe(true);

    await expect(capability.sendOwnerDraft(original)).resolves.toMatchObject({
      outcome: "accepted",
      messageId: "mail-original",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(() => capability.prepareOwnerDraft(replacement)).not.toThrow();
  });

  it("treats preparing the same Draft tuple as idempotent", () => {
    const capability = createCapability(vi.fn());
    const request = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };

    capability.prepareOwnerDraft(request);
    expect(() => capability.prepareOwnerDraft(request)).not.toThrow();
  });

  it("expires an abandoned prepared Draft before accepting a fresh binding", async () => {
    const now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/drafts/E99/send");
      expect(JSON.parse(String(init?.body))).toEqual({ mailboxId: "42", draftVersion: 4 });
      return new Response(JSON.stringify({
        outcome: "accepted",
        messageId: "mail-replacement",
        submissionIds: ["submission-replacement"],
      }), { status: 200 });
    });
    const capability = createCapability(fetchMock);
    const abandoned = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };
    const replacement = {
      ...abandoned,
      draftId: "E99",
      draftVersion: 4,
    };
    const staleConfirmation = {
      accountId: "bot-1",
      sessionKey: abandoned.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message({ message_id: "msg-abandoned-draft" }),
    };

    capability.prepareOwnerDraft(abandoned);
    expect(() => capability.prepareOwnerDraft(replacement)).toThrow("different mail Draft");

    nowSpy.mockReturnValue(now + 2 * 60_000);
    expect(recordOwnerDraftConfirmation({ ...staleConfirmation, nowMs: Date.now() })).toBe(false);
    expect(() => capability.prepareOwnerDraft(replacement)).not.toThrow();
    expect(recordOwnerDraftConfirmation({ ...staleConfirmation, nowMs: Date.now() })).toBe(false);
    expect(recordOwnerDraftConfirmation({
      ...staleConfirmation,
      message: message({ message_id: "msg-replacement-draft" }),
      nowMs: Date.now(),
    })).toBe(true);

    await expect(capability.sendOwnerDraft(replacement)).resolves.toMatchObject({
      outcome: "accepted",
      messageId: "mail-replacement",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["mailbox", { mailboxId: "43" }],
    ["Draft id", { draftId: "E18" }],
    ["Draft version", { draftVersion: 4 }],
  ])("consumes and rejects a confirmation for a mismatched %s", async (_name, mismatch) => {
    const fetchMock = vi.fn();
    const capability = createCapability(fetchMock);
    const request = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };
    capability.prepareOwnerDraft(request);
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: request.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message({ message_id: `msg-mismatch-${_name}` }),
    })).toBe(true);

    await expect(capability.sendOwnerDraft({ ...request, ...mismatch }))
      .rejects.toThrow("No matching exact");
    await expect(capability.sendOwnerDraft(request)).rejects.toThrow("No matching exact");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not recreate a consumed confirmation when the same inbound message is replayed", async () => {
    const confirmation = {
      accountId: "bot-1",
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message({ message_id: "msg-replayed" }),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      outcome: "accepted",
      messageId: "mail-1",
      submissionIds: [7],
    }), { status: 200 }));
    const capability = createCapability(fetchMock);
    const firstDraft = {
      sessionKey: confirmation.sessionKey,
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };
    capability.prepareOwnerDraft(firstDraft);
    expect(recordOwnerDraftConfirmation(confirmation)).toBe(true);
    await expect(capability.sendOwnerDraft(firstDraft)).resolves.toMatchObject({
      outcome: "accepted",
      messageId: "mail-1",
    });

    const secondDraft = {
      ...firstDraft,
      draftId: "E18",
      draftVersion: 4,
    };
    capability.prepareOwnerDraft(secondDraft);
    expect(recordOwnerDraftConfirmation(confirmation)).toBe(false);
    await expect(capability.sendOwnerDraft(firstDraft)).rejects.toThrow("No matching exact");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    capability.prepareOwnerDraft(secondDraft);
    expect(recordOwnerDraftConfirmation({
      ...confirmation,
      message: message({ message_id: "msg-new-confirmation" }),
    })).toBe(true);
    await expect(capability.sendOwnerDraft(secondDraft))
      .resolves.toMatchObject({ outcome: "accepted" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a consumed confirmation replayed after an account restart", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      outcome: "accepted",
      messageId: "mail-1",
      submissionIds: ["submission-1"],
    }), { status: 200 }));
    const capability = createCapability(fetchMock);
    const firstDraft = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };
    const consumedMessage = message({ message_id: "msg-before-restart" });

    capability.prepareOwnerDraft(firstDraft);
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: firstDraft.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: consumedMessage,
    })).toBe(true);
    await expect(capability.sendOwnerDraft(firstDraft)).resolves.toMatchObject({
      outcome: "accepted",
    });

    clearOwnerDraftConfirmations("bot-1");
    nowSpy.mockReturnValue(1_120_000);
    const nextDraft = {
      ...firstDraft,
      draftId: "E18",
      draftVersion: 4,
    };
    capability.prepareOwnerDraft(nextDraft);

    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: nextDraft.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: consumedMessage,
      nowMs: Date.now(),
    })).toBe(false);
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: nextDraft.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message({ message_id: "msg-after-restart" }),
      nowMs: Date.now(),
    })).toBe(true);
    await expect(capability.sendOwnerDraft(nextDraft)).resolves.toMatchObject({
      outcome: "accepted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves preparation when delivery is attempted before confirmation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      outcome: "accepted",
      messageId: "mail-1",
      submissionIds: ["submission-1"],
    }), { status: 200 }));
    const capability = createCapability(fetchMock);
    const request = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };
    capability.prepareOwnerDraft(request);

    await expect(capability.sendOwnerDraft(request)).rejects.toThrow("No matching exact");
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: request.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message({ message_id: "msg-after-premature-send" }),
    })).toBe(true);
    await expect(capability.sendOwnerDraft(request)).resolves.toMatchObject({
      outcome: "accepted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not evict an earlier replay tombstone after many later confirmations", async () => {
    const capability = createCapability(vi.fn(async () => new Response(JSON.stringify({
      outcome: "accepted",
      messageId: "mail-1",
      submissionIds: [],
    }), { status: 200 })));
    const first = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 1,
    };
    const firstConfirmation = {
      accountId: "bot-1",
      sessionKey: first.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message({ message_id: "msg-oldest" }),
    };
    capability.prepareOwnerDraft(first);
    expect(recordOwnerDraftConfirmation(firstConfirmation)).toBe(true);
    await capability.sendOwnerDraft(first);
    capability.prepareOwnerDraft(first);

    for (let index = 0; index < 4_096; index += 1) {
      const sessionKey = `agent:a:octo:direct:space-1:owner-${index + 2}`;
      capability.prepareOwnerDraft({ ...first, sessionKey });
      expect(recordOwnerDraftConfirmation({
        ...firstConfirmation,
        sessionKey,
        message: message({ message_id: `msg-later-${index}` }),
      })).toBe(true);
    }

    expect(recordOwnerDraftConfirmation(firstConfirmation)).toBe(false);
  });

  it.each([
    ["revoked", undefined],
    ["changed", "owner-2"],
  ])("rejects a confirmation after the registered Owner is %s", async (name, nextOwner) => {
    let currentOwnerUid: string | undefined = "owner-1";
    const fetchMock = vi.fn();
    const capability = createOwnerDraftDeliveryCapability({
      accountId: "bot-1",
      apiUrl: "https://octo.example/api",
      botToken: "bf_secret",
      getCurrentOwnerUid: () => currentOwnerUid,
      fetchImpl: fetchMock as typeof fetch,
    });
    const request = {
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    };
    capability.prepareOwnerDraft(request);
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: request.sessionKey,
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message({ message_id: `msg-owner-${name}` }),
    })).toBe(true);

    currentOwnerUid = nextOwner;

    await expect(capability.sendOwnerDraft(request)).rejects.toThrow("No matching exact");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scopes replay tombstones to the OCTO account", () => {
    const sharedMessage = message({ message_id: "msg-shared-id" });
    const first = createCapability(vi.fn(), "bot-1");
    const second = createCapability(vi.fn(), "bot-2");
    first.prepareOwnerDraft({
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    });
    second.prepareOwnerDraft({
      sessionKey: "agent:b:octo:direct:space-1:owner-1",
      mailboxId: "43",
      draftId: "E18",
      draftVersion: 1,
    });
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: sharedMessage,
    })).toBe(true);
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-2",
      sessionKey: "agent:b:octo:direct:space-1:owner-1",
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: sharedMessage,
    })).toBe(true);
  });

  it.each([
    ["non-owner", { from_uid: "attacker" }],
    ["group", { channel_type: ChannelType.Group }],
    ["non-text", { payload: { type: MessageType.Image, content: "确认发送" } }],
    ["fuzzy", { payload: { type: MessageType.Text, content: "我确认发送" } }],
  ])("does not grant for %s input", (_name, overrides) => {
    const capability = createCapability(vi.fn());
    capability.prepareOwnerDraft({
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      mailboxId: "42",
      draftId: "E17",
      draftVersion: 3,
    });
    expect(recordOwnerDraftConfirmation({
      accountId: "bot-1",
      sessionKey: "agent:a:octo:direct:space-1:owner-1",
      spaceId: "space-1",
      ownerUid: "owner-1",
      message: message(overrides as Partial<BotMessage>),
    })).toBe(false);
  });
});

function createCapability(fetchImpl: ReturnType<typeof vi.fn>, accountId = "bot-1") {
  return createOwnerDraftDeliveryCapability({
    accountId,
    apiUrl: "https://octo.example/api/",
    botToken: "bf_secret",
    getCurrentOwnerUid: () => "owner-1",
    fetchImpl: fetchImpl as typeof fetch,
  });
}
