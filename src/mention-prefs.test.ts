import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getMentionPrefFromCache,
  invalidateMentionPref,
  preloadMentionPrefs,
  _clearMentionPrefCache,
  _setMentionPrefEntry,
  _hasMentionPrefEntry,
} from "./mention-prefs.js";

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const API = "http://localhost:8090";
const TOKEN = "tok";

describe("mention-prefs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearMentionPrefCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearMentionPrefCache();
  });

  describe("getMentionPrefFromCache", () => {
    it("returns cached pref without hitting the network", async () => {
      _setMentionPrefEntry("acct1", "g100", { no_mention: true });
      const spy = vi.fn();
      globalThis.fetch = spy as unknown as typeof fetch;

      const pref = await getMentionPrefFromCache({
        accountId: "acct1",
        parentGroupNo: "g100",
        apiUrl: API,
        botToken: TOKEN,
      });

      expect(pref).toEqual({ no_mention: true });
      expect(spy).not.toHaveBeenCalled();
    });

    it("pulls and caches on miss, hitting the mention_pref endpoint", async () => {
      const fetchMock = mockFetch(async (url) => {
        expect(url).toBe(`${API}/v1/bot/groups/g200/mention_pref`);
        return jsonResponse({ no_mention: true });
      });
      globalThis.fetch = fetchMock;

      const pref = await getMentionPrefFromCache({
        accountId: "acct1",
        parentGroupNo: "g200",
        apiUrl: API,
        botToken: TOKEN,
      });

      expect(pref).toEqual({ no_mention: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(_hasMentionPrefEntry("acct1", "g200")).toBe(true);

      // Second call served from cache.
      await getMentionPrefFromCache({
        accountId: "acct1",
        parentGroupNo: "g200",
        apiUrl: API,
        botToken: TOKEN,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("isolates prefs per-bot in the same group (composite key)", async () => {
      const fetchMock = mockFetch(async (url, init) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        // Bot A → no_mention, Bot B → needs @
        return jsonResponse({ no_mention: auth === "Bearer tokA" });
      });
      globalThis.fetch = fetchMock;

      const a = await getMentionPrefFromCache({
        accountId: "botA",
        parentGroupNo: "shared",
        apiUrl: API,
        botToken: "tokA",
      });
      const b = await getMentionPrefFromCache({
        accountId: "botB",
        parentGroupNo: "shared",
        apiUrl: API,
        botToken: "tokB",
      });

      expect(a).toEqual({ no_mention: true });
      expect(b).toEqual({ no_mention: false });
      expect(_hasMentionPrefEntry("botA", "shared")).toBe(true);
      expect(_hasMentionPrefEntry("botB", "shared")).toBe(true);
    });

    it("refreshes after TTL expiry", async () => {
      _setMentionPrefEntry("acct1", "g300", { no_mention: true }, -1); // already expired
      const fetchMock = mockFetch(async () => jsonResponse({ no_mention: false }));
      globalThis.fetch = fetchMock;

      const pref = await getMentionPrefFromCache({
        accountId: "acct1",
        parentGroupNo: "g300",
        apiUrl: API,
        botToken: TOKEN,
      });

      expect(pref).toEqual({ no_mention: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to account-level (no_mention:false) on API failure", async () => {
      const fetchMock = mockFetch(async () => new Response("boom", { status: 500 }));
      globalThis.fetch = fetchMock;

      const pref = await getMentionPrefFromCache({
        accountId: "acct1",
        parentGroupNo: "g400",
        apiUrl: API,
        botToken: TOKEN,
      });

      expect(pref).toEqual({ no_mention: false });
    });

    it("caches a negative (no_mention=false) result with a short TTL so it re-pulls soon", async () => {
      // Negative results (genuine "needs @" OR failure fallback) must not be
      // pinned for the full 5min positive TTL — a freshly-enabled 免@ should
      // surface within the short negative window. We assert the entry expires
      // well before 5min by advancing the clock past the 30s negative TTL.
      vi.useFakeTimers();
      try {
        let calls = 0;
        const fetchMock = mockFetch(async () => {
          calls++;
          // First pull: needs @ (negative). Second pull (after short TTL): 免@.
          return jsonResponse({ no_mention: calls >= 2 });
        });
        globalThis.fetch = fetchMock;

        const first = await getMentionPrefFromCache({
          accountId: "acct1",
          parentGroupNo: "gneg",
          apiUrl: API,
          botToken: TOKEN,
        });
        expect(first).toEqual({ no_mention: false });
        expect(calls).toBe(1);

        // Just before the negative TTL elapses → still served from cache.
        vi.advanceTimersByTime(29 * 1000);
        const cached = await getMentionPrefFromCache({
          accountId: "acct1",
          parentGroupNo: "gneg",
          apiUrl: API,
          botToken: TOKEN,
        });
        expect(cached).toEqual({ no_mention: false });
        expect(calls).toBe(1);

        // Past the 30s negative TTL → re-pulls and now sees 免@.
        vi.advanceTimersByTime(2 * 1000);
        const refreshed = await getMentionPrefFromCache({
          accountId: "acct1",
          parentGroupNo: "gneg",
          apiUrl: API,
          botToken: TOKEN,
        });
        expect(refreshed).toEqual({ no_mention: true });
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("caches a positive (no_mention=true) result for the full 5min TTL", async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = mockFetch(async () => jsonResponse({ no_mention: true }));
        globalThis.fetch = fetchMock;

        const first = await getMentionPrefFromCache({
          accountId: "acct1",
          parentGroupNo: "gpos",
          apiUrl: API,
          botToken: TOKEN,
        });
        expect(first).toEqual({ no_mention: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Past the 30s negative window but within 5min → still cached (positive TTL).
        vi.advanceTimersByTime(60 * 1000);
        const cached = await getMentionPrefFromCache({
          accountId: "acct1",
          parentGroupNo: "gpos",
          apiUrl: API,
          botToken: TOKEN,
        });
        expect(cached).toEqual({ no_mention: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("invalidateMentionPref", () => {
    it("removes only the targeted (bot, group) entry", () => {
      _setMentionPrefEntry("acct1", "g1", { no_mention: true });
      _setMentionPrefEntry("acct1", "g2", { no_mention: true });
      invalidateMentionPref("acct1", "g1");
      expect(_hasMentionPrefEntry("acct1", "g1")).toBe(false);
      expect(_hasMentionPrefEntry("acct1", "g2")).toBe(true);
    });
  });

  describe("preloadMentionPrefs", () => {
    it("warms the cache for all bot groups", async () => {
      const fetchMock = mockFetch(async (url) => {
        if (url.endsWith("/v1/bot/groups")) {
          return jsonResponse([{ group_no: "g1", name: "G1" }, { group_no: "g2", name: "G2" }]);
        }
        return jsonResponse({ no_mention: true });
      });
      globalThis.fetch = fetchMock;

      await preloadMentionPrefs({ accountId: "acct1", apiUrl: API, botToken: TOKEN });

      expect(_hasMentionPrefEntry("acct1", "g1")).toBe(true);
      expect(_hasMentionPrefEntry("acct1", "g2")).toBe(true);
    });

    it("degrades silently when group list fetch fails", async () => {
      const fetchMock = mockFetch(async (url) => {
        if (url.endsWith("/v1/bot/groups")) return new Response("nope", { status: 500 });
        return jsonResponse({ no_mention: true });
      });
      globalThis.fetch = fetchMock;

      await expect(
        preloadMentionPrefs({ accountId: "acct1", apiUrl: API, botToken: TOKEN }),
      ).resolves.toBeUndefined();
    });
  });
});
