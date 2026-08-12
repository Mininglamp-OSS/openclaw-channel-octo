import { describe, it, expect, beforeEach } from "vitest";
import {
  registerOwnerUid,
  getOwnerUid,
  isOwner,
  _clearOwnerRegistry,
} from "./owner-registry.js";

describe("owner-registry case-insensitive accountId (issue #33)", () => {
  beforeEach(() => _clearOwnerRegistry());

  it("registered lowercase, queried lowercase → hit", () => {
    registerOwnerUid("27pb_bot", "owner-uid");
    expect(isOwner("27pb_bot", "owner-uid")).toBe(true);
  });

  it("registered lowercase, queried mixed-case → hit", () => {
    registerOwnerUid("27pb_bot", "owner-uid");
    expect(isOwner("27Pb_bot", "owner-uid")).toBe(true);
  });

  it("registered mixed-case, queried lowercase → hit (the main bug case)", () => {
    // This is the scenario from PR#55 / issue #33: BotFather emits
    // mixed-case ID, channel registers it, OpenClaw routes a lowercased
    // version into isOwner — strict equality used to miss here.
    registerOwnerUid("27Pb_bot", "owner-uid");
    expect(isOwner("27pb_bot", "owner-uid")).toBe(true);
  });

  it("registered mixed-case A, queried mixed-case B (different case form) → hit", () => {
    registerOwnerUid("AbCd_bot", "owner-uid");
    expect(getOwnerUid("aBcD_bot")).toBe("owner-uid");
    expect(isOwner("aBcD_bot", "owner-uid")).toBe(true);
    expect(isOwner("ABCD_bot", "owner-uid")).toBe(true);
  });

  it("wrong uid still returns false (case fix doesn't break uid check)", () => {
    registerOwnerUid("AbCd_bot", "owner-uid");
    expect(isOwner("abcd_bot", "wrong-uid")).toBe(false);
  });

  it("unregistered account returns false regardless of case", () => {
    expect(getOwnerUid("never_registered_bot")).toBeUndefined();
    expect(isOwner("never_registered_bot", "anyuid")).toBe(false);
    expect(isOwner("NEVER_REGISTERED_BOT", "anyuid")).toBe(false);
  });

  it("re-registering with different case overwrites the owner uid", () => {
    registerOwnerUid("Bot_bot", "owner-one");
    registerOwnerUid("BOT_bot", "owner-two"); // same canonical id
    expect(isOwner("bot_bot", "owner-one")).toBe(false);
    expect(isOwner("bot_bot", "owner-two")).toBe(true);
  });

  it("clears a stale owner when refresh no longer returns an owner uid", () => {
    registerOwnerUid("Bot_bot", "owner-one");
    registerOwnerUid("BOT_bot", undefined);

    expect(getOwnerUid("bot_bot")).toBeUndefined();
    expect(isOwner("bot_bot", "owner-one")).toBe(false);
  });
});
