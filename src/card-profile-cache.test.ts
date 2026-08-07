import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api-fetch.js", () => ({
  getCardProfile: vi.fn(),
}));

import { getCardProfile, type CardProfileManifest } from "./api-fetch.js";
import {
  _resetBotCardProfileCacheForTests,
  getBotCardProfile,
  invalidateBotCardProfile,
  peekBotCardProfile,
} from "./card-profile-cache.js";

function profile(displayEnabled: boolean): CardProfileManifest {
  return {
    available: true,
    enabled: true,
    profiles: ["octo/v1", "octo/v2"],
    card_version: "1.5",
    config: {
      card_enabled: true,
      display_enabled: displayEnabled,
      interaction_enabled: true,
      reasoning_enabled: true,
      reasoning_template_ref: { id: "ai.reasoning-process", version: "0.3.0" },
    },
  };
}

describe("bot card profile cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetBotCardProfileCacheForTests();
  });

  afterEach(() => {
    _resetBotCardProfileCacheForTests();
  });

  it("is private to apiUrl + botToken and supports synchronous discovery peeks", async () => {
    vi.mocked(getCardProfile)
      .mockResolvedValueOnce(profile(false))
      .mockResolvedValueOnce(profile(true));

    const botA = { apiUrl: "https://api.test", botToken: "bot-a" };
    const botB = { apiUrl: "https://api.test", botToken: "bot-b" };
    expect(peekBotCardProfile(botA)).toBeUndefined();

    await getBotCardProfile(botA);
    await getBotCardProfile(botB);

    expect(peekBotCardProfile(botA)?.config?.display_enabled).toBe(false);
    expect(peekBotCardProfile(botB)?.config?.display_enabled).toBe(true);
    expect(getCardProfile).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the matching bot and refetches it on the next authoritative read", async () => {
    vi.mocked(getCardProfile)
      .mockResolvedValueOnce(profile(false))
      .mockResolvedValueOnce(profile(true))
      .mockResolvedValueOnce(profile(true));
    const botA = { apiUrl: "https://api.test", botToken: "bot-a" };
    const botB = { apiUrl: "https://api.test", botToken: "bot-b" };
    await getBotCardProfile(botA);
    await getBotCardProfile(botB);

    invalidateBotCardProfile(botA);

    expect(peekBotCardProfile(botA)).toBeUndefined();
    expect(peekBotCardProfile(botB)?.config?.display_enabled).toBe(true);
    expect((await getBotCardProfile(botA)).config?.display_enabled).toBe(true);
    expect(getCardProfile).toHaveBeenCalledTimes(3);
  });

  it("does not cache profile read failures as a disabled result", async () => {
    vi.mocked(getCardProfile)
      .mockRejectedValueOnce(new Error("profile unavailable"))
      .mockResolvedValueOnce(profile(true));
    const bot = { apiUrl: "https://api.test", botToken: "bot-a" };

    await expect(getBotCardProfile(bot)).rejects.toThrow("profile unavailable");
    expect(peekBotCardProfile(bot)).toBeUndefined();
    await expect(getBotCardProfile(bot)).resolves.toEqual(profile(true));
    expect(getCardProfile).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent reads for the same Bot", async () => {
    let resolveRead!: (value: CardProfileManifest) => void;
    vi.mocked(getCardProfile).mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    const bot = { apiUrl: "https://api.test", botToken: "bot-a" };

    const first = getBotCardProfile(bot);
    const second = getBotCardProfile(bot);
    expect(getCardProfile).toHaveBeenCalledTimes(1);

    resolveRead(profile(true));
    await expect(Promise.all([first, second])).resolves.toEqual([profile(true), profile(true)]);
  });

  it("discards a pre-invalidation response and refreshes before resolving the waiting caller", async () => {
    let resolveStale!: (value: CardProfileManifest) => void;
    vi.mocked(getCardProfile)
      .mockReturnValueOnce(new Promise((resolve) => { resolveStale = resolve; }))
      .mockResolvedValueOnce(profile(true));
    const bot = { apiUrl: "https://api.test", botToken: "bot-a" };

    const staleRead = getBotCardProfile(bot);
    invalidateBotCardProfile(bot);
    resolveStale(profile(false));
    await expect(staleRead).resolves.toEqual(profile(true));
    expect(peekBotCardProfile(bot)?.config?.display_enabled).toBe(true);
    expect(getCardProfile).toHaveBeenCalledTimes(2);
  });
});
