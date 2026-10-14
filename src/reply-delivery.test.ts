import { describe, expect, it } from "vitest";
import { confirmsCurrentSourceReply, extractToolSendResult, targetsMatchForReplySuppression } from "./reply-delivery.js";
import { octoPlugin, toActionToolResult } from "./channel.js";
import { normalizeOctoMessagingTarget } from "./target.js";
import { DOC_TASK_NON_ROUTABLE_PREFIX } from "./constants.js";
import { ChannelType } from "./types.js";

describe("actual source delivery confirmation", () => {
  it("recognizes a parent request actually delivered to the current child", () => {
    expect(confirmsCurrentSourceReply({
      currentTarget: "octo:g____one",
      result: { ok: true, data: { sent: true, target: "group:g", resolvedTarget: "g____one", channelType: ChannelType.CommunityTopic } },
    })).toBe(true);
  });
  it.each([
    { sent: true, resolvedTarget: "g", channelType: ChannelType.Group },
    { sent: true, resolvedTarget: "g____two", channelType: ChannelType.CommunityTopic },
    { sent: true, resolvedTarget: "g____one", channelType: ChannelType.DM },
    { sent: false, resolvedTarget: "g____one", channelType: ChannelType.CommunityTopic },
    { sent: true, resolvedTarget: "g____one", channelType: ChannelType.CommunityTopic, failedMedia: ["missing.md"] },
  ])("does not certify cross-route or incomplete sends: %o", data => {
    expect(confirmsCurrentSourceReply({ currentTarget: "octo:g____one", result: { ok: true, data } })).toBe(false);
  });
});

describe("OpenClaw source-reply target normalization", () => {
  it.each(["uid", " user:uid ", "octo:uid", "octo:user:uid"])("normalizes DM alias %s", target => {
    expect(normalizeOctoMessagingTarget(target)).toBe("user:uid");
  });
  it.each(["g", "octo:g", "channel:octo:g", "group:g"])("normalizes known group alias %s", target => {
    expect(normalizeOctoMessagingTarget(target, new Set(["g"]))).toBe("group:g");
  });
  it("preserves explicit routing, thread identity and mention recipients", () => {
    expect(normalizeOctoMessagingTarget("user:g", new Set(["g"]))).toBe("user:g");
    expect(normalizeOctoMessagingTarget("group:uid")).toBe("group:uid");
    expect(normalizeOctoMessagingTarget("octo:g____one")).toBe("group:g____one");
    expect(normalizeOctoMessagingTarget("channel:octo:g@uid1,uid2")).toBe("group:g@uid1,uid2");
  });
  it("preserves empty and non-routable document targets", () => {
    expect(normalizeOctoMessagingTarget(" ")).toBe("");
    const target = `${DOC_TASK_NON_ROUTABLE_PREFIX}test`;
    expect(normalizeOctoMessagingTarget(target)).toBe(target);
  });
});

describe("message-tool reply route evidence (#257)", () => {
  it.each(["uid", "user:uid", "octo:user:uid"])("matches the current DM against %s", targetKey => {
    expect(targetsMatchForReplySuppression({ originTarget: "octo:uid", targetKey })).toBe(true);
  });
  it.each(["group:g", "channel:g", "channel:octo:g@someone"])("matches group aliases without changing routing: %s", targetKey => {
    expect(targetsMatchForReplySuppression({ originTarget: "octo:g", targetKey })).toBe(true);
  });
  it.each([
    { originTarget: "octo:uid", targetKey: "user:other" },
    { originTarget: "user:id", targetKey: "group:id" },
    { originTarget: "octo:g____one", targetKey: "group:g____two" },
    { originTarget: "octo:g____one", targetKey: "group:g" },
    { originTarget: "octo:g", targetKey: "group:g", targetThreadId: "one" },
    { originTarget: "octo:g____one", targetKey: "group:g", targetThreadId: "other____one" },
    { originTarget: "", targetKey: "user:" },
  ])("does not suppress an answer after sending somewhere else: %o", route => {
    expect(targetsMatchForReplySuppression(route)).toBe(false);
  });
  it("recognizes a parent target with the current child thread", () => {
    expect(targetsMatchForReplySuppression({ originTarget: "octo:g____one", targetKey: "group:g", targetThreadId: "one" })).toBe(true);
  });
  it("extracts the successful action's corrected account and effective destination", () => {
    const receipt = extractToolSendResult({
      result: toActionToolResult({ ok: true, data: { sent: true, resolvedTarget: "g____one", channelType: ChannelType.CommunityTopic, accountId: "correct-account" } }),
      send: { to: "group:g", accountId: "wrong-account" },
    });
    expect(receipt).toEqual({ to: "group:g____one", accountId: "correct-account", threadSuppressed: true });
    expect(targetsMatchForReplySuppression({ originTarget: "octo:g____one", targetKey: receipt!.to })).toBe(true);
  });
  it.each([
    { source: "octo:user:u", actual: "u", channelType: ChannelType.DM, expected: "user:u" },
    { source: "octo:group:uncached", actual: "uncached", channelType: ChannelType.Group, expected: "group:uncached" },
    { source: "octo:group:uncached____one", actual: "uncached____one", channelType: ChannelType.CommunityTopic, expected: "group:uncached____one" },
  ])("reconciles delivery through the actual plugin hooks with a cold group cache: %o", ({ source, actual, channelType, expected }) => {
    const pending = octoPlugin.actions!.extractToolSend!({ args: { target: expected, accountId: "bot" } } as never);
    const confirmed = octoPlugin.actions!.extractToolSendResult!({
      send: pending,
      result: toActionToolResult({ ok: true, data: { sent: true, resolvedTarget: actual, channelType } }),
    } as never)!;
    expect(confirmed.to).toBe(expected);
    const normalize = octoPlugin.messaging!.normalizeTarget!;
    expect(normalize(source)).toBe(expected);
    expect(normalize(confirmed.to!)).toBe(normalize(source));
    expect(octoPlugin.outbound!.targetsMatchForReplySuppression!({ originTarget: source, targetKey: confirmed.to! })).toBe(true);
  });
  it.each([
    { ok: false, data: { sent: true, resolvedTarget: "g" } },
    { ok: true, data: { sent: false, resolvedTarget: "g" } },
    { ok: true, data: { sent: true, resolvedTarget: "" } },
    ...[[{ url: "missing.png", error: "403" }], "malformed"].map(failedMedia => ({
      ok: true, data: { sent: true, resolvedTarget: "g", channelType: ChannelType.Group, failedMedia },
    })),
  ])("does not turn an unsuccessful action into delivery evidence", details => {
    expect(extractToolSendResult({ result: { details }, send: { to: "group:g" } })).toBeUndefined();
  });
});
