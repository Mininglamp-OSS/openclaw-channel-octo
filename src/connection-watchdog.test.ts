import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WATCHDOG_INTERVAL_MS, createConnectionWatchdog } from "./connection-watchdog.js";

describe("createConnectionWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const make = (
    shouldReconnect: () => boolean,
    reconnect: () => void | Promise<void> = vi.fn(),
  ) => {
    // Pinned so the jittered period is exactly intervalMs and the tests can reason about
    // when a tick lands.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const warns: string[] = [];
    const dog = createConnectionWatchdog({
      intervalMs: 1_000,
      accountId: "bot",
      shouldReconnect,
      reconnect,
      log: { warn: (m) => warns.push(m) },
    });
    return { dog, warns };
  };

  it("revives a connection nobody else is managing", async () => {
    const reconnect = vi.fn();
    const { dog, warns } = make(() => true, reconnect);
    dog.start();
    await vi.advanceTimersByTimeAsync(1_000);
    dog.stop();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(warns[0]).toContain("bot");
  });

  it("stays out of the way when the predicate says no", async () => {
    const reconnect = vi.fn();
    const { dog } = make(() => false, reconnect);
    dog.start();
    await vi.advanceTimersByTimeAsync(5_000);
    dog.stop();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not consult the predicate after stop", async () => {
    const shouldReconnect = vi.fn(() => false);
    const { dog } = make(shouldReconnect);
    dog.start();
    dog.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(shouldReconnect).not.toHaveBeenCalled();
  });

  // The revive is asynchronous; a later tick must not stack a second one on top of it, or
  // two reconnect sequences would race and kick each other's socket.
  it("does not overlap revives", async () => {
    let release: (() => void) | undefined;
    const reconnect = vi.fn(() => new Promise<void>((res) => (release = res)));
    const { dog } = make(() => true, reconnect);
    dog.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnect).toHaveBeenCalledTimes(2); // free again once the first finished
    dog.stop();
  });

  it("keeps watching after a revive throws", async () => {
    const reconnect = vi.fn(async () => {
      throw new Error("connect failed");
    });
    const { dog, warns } = make(() => true, reconnect);
    dog.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warns.some((m) => m.includes("connect failed"))).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconnect).toHaveBeenCalledTimes(2); // the flag was released, not stuck
    dog.stop();
  });

  it("is idempotent on repeated start", async () => {
    const reconnect = vi.fn();
    const { dog } = make(() => true, reconnect);
    dog.start();
    dog.start();
    await vi.advanceTimersByTimeAsync(1_000);
    dog.stop();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("defaults to a slow period, since this is a backstop and not the main path", () => {
    expect(WATCHDOG_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("jitters the period so accounts in one process do not check in lockstep", async () => {
    const periods = new Set<number>();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    for (const r of [0, 0.5, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(r);
      const dog = createConnectionWatchdog({
        intervalMs: 1_000,
        accountId: "bot",
        shouldReconnect: () => false,
        reconnect: vi.fn(),
      });
      dog.start();
      periods.add(setIntervalSpy.mock.calls.at(-1)?.[1] as number);
      dog.stop();
    }
    expect(periods.size).toBe(3);
  });
});
