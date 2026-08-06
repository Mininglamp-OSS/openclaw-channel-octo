/**
 * Cross-repo E2E for the /v1/bot/events long poll, env-gated like card-e2e.test.ts.
 *
 * Unit tests can only prove the plugin *sends* `wait`; they mock the server, so they cannot
 * prove the server understands it. This suite drives the real client code against a real
 * octo-server and asserts the one thing that spans both repos: the hold is honoured, and it
 * ends early when an event actually lands.
 *
 * Run:
 *   OCTO_E2E_API_URL=http://127.0.0.1:8090 OCTO_E2E_BOT_TOKEN=… \
 *   OCTO_E2E_REDIS_CLI=redis-cli OCTO_E2E_BOT_ID=… OCTO_E2E_ALLOW_DESTRUCTIVE=1 \
 *     npx vitest run src/events-longpoll-e2e.test.ts
 *
 * API_URL + BOT_TOKEN alone run the read-only timing checks — safe against any server. The
 * wake-up check additionally needs BOT_ID, a redis-cli that can reach the server's Redis, and an
 * explicit OCTO_E2E_ALLOW_DESTRUCTIVE=1, because it has to inject an event into the bot's queue
 * out of band (no HTTP endpoint enqueues one on demand) and clears that queue first. Point it at
 * a throwaway bot: it deletes robotEvent:{BOT_ID} and its doorbell, before and after (in a
 * finally, so a failed assertion still cleans up).
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fetchBotEvents } from "./api-fetch.js";

const API = process.env.OCTO_E2E_API_URL;
const TOKEN = process.env.OCTO_E2E_BOT_TOKEN;
const BOT_ID = process.env.OCTO_E2E_BOT_ID;
const REDIS_CLI = process.env.OCTO_E2E_REDIS_CLI;

const suite = API && TOKEN ? describe : describe.skip;

suite("events long-poll E2E（真实 octo-server）", () => {
  it("不传 waitSeconds 时立即返回 —— 旧行为未被改变", async () => {
    const started = Date.now();
    const events = await fetchBotEvents({ apiUrl: API!, botToken: TOKEN! });
    const elapsed = Date.now() - started;

    expect(Array.isArray(events)).toBe(true);
    // An upgraded server must not start holding requests that never asked it to; that is what
    // keeps existing bots (with their 10s client timeout) working untouched.
    expect(elapsed).toBeLessThan(1_000);
  }, 30_000);

  it("传了 waitSeconds 时服务端真的 hold 住，且到期返回普通空响应", async () => {
    const started = Date.now();
    const events = await fetchBotEvents({ apiUrl: API!, botToken: TOKEN!, waitSeconds: 3 });
    const elapsed = Date.now() - started;

    // Proves the server parsed `wait` rather than ignoring an unknown field.
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    // An expired hold is an ordinary empty batch — no timeout status for the client to handle.
    expect(events).toEqual([]);
  }, 30_000);

  // The wake-up case is destructive: it DELs the bot's event queue and doorbell to get a clean
  // measurement, which would discard real queued events if pointed at a shared bot. Gate it
  // behind an explicit opt-in so the env vars alone can never trigger it.
  const DESTRUCTIVE_OK = process.env.OCTO_E2E_ALLOW_DESTRUCTIVE === "1";
  const wakeIt = API && TOKEN && BOT_ID && REDIS_CLI && DESTRUCTIVE_OK ? it : it.skip;
  wakeIt("事件在 hold 期间到达时提前返回 —— 这次改动的全部意义（需 OCTO_E2E_ALLOW_DESTRUCTIVE=1，会清空该 bot 队列）", async () => {
    const queueKey = `robotEvent:${BOT_ID}`;
    const bellKey = `robotEventBell:${BOT_ID}`;
    const redis = (...args: string[]) =>
      execFileSync(REDIS_CLI!, args, { encoding: "utf8" }).trim();

    const cleanup = () => {
      redis("DEL", queueKey);
      redis("DEL", bellKey);
    };
    cleanup();

    const eventId = 900001;
    const payload = JSON.stringify({
      event_id: eventId,
      event_type: "card_action",
      event_data: { action_id: "approve" },
    });

    // Land the event ~1.5s into a 20s hold, so an early return can only come from the doorbell
    // and not from the read-before-wait short circuit.
    const injected = new Promise<number>((resolve) => {
      setTimeout(() => {
        redis("ZADD", queueKey, String(eventId), payload);
        redis("LPUSH", bellKey, "1");
        resolve(Date.now());
      }, 1_500);
    });

    try {
      const started = Date.now();
      const [events, injectedAt] = await Promise.all([
        fetchBotEvents({ apiUrl: API!, botToken: TOKEN!, waitSeconds: 20 }),
        injected,
      ]);
      const returnedAt = Date.now();

      expect(events.map((event) => event.event_id)).toContain(eventId);
      // The hold must break on the doorbell, not run to its 20s deadline.
      expect(returnedAt - started).toBeLessThan(10_000);
      // And it must react to the event, not merely happen to finish around then.
      expect(returnedAt - injectedAt).toBeLessThan(3_000);
    } finally {
      // Must run even on a failed assertion or timeout: otherwise the injected event and the
      // doorbell token survive and poison the next run, and any bot sharing this id.
      cleanup();
    }
  }, 60_000);
});
