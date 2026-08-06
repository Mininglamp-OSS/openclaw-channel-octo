import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWatchdogPredicate,
  createDeferredReconnect,
  createReconnectSequencer,
  createSingleFlightFlag,
} from "./reconnect-coordination.js";

describe("createReconnectSequencer", () => {
  it("reports in-flight for the whole sequence, including across awaits", async () => {
    const seq = createReconnectSequencer();
    let release: (() => void) | undefined;
    expect(seq.isInFlight()).toBe(false);

    const first = seq.run("a", () => new Promise<void>((res) => (release = res)));
    // The window that matters: a sequence that has already torn the old socket down but
    // not yet built the new one leaves no other trace of itself.
    expect(seq.isInFlight()).toBe(true);

    release?.();
    await first;
    expect(seq.isInFlight()).toBe(false);
  });

  it("refuses a second sequence while one is running", async () => {
    const seq = createReconnectSequencer();
    let release: (() => void) | undefined;
    const first = seq.run("a", () => new Promise<void>((res) => (release = res)));

    const second = vi.fn(async () => {});
    await seq.run("b", second);
    expect(second).not.toHaveBeenCalled();

    release?.();
    await first;
  });

  it("accepts a new sequence once the previous one finished", async () => {
    const seq = createReconnectSequencer();
    await seq.run("a", async () => {});
    const second = vi.fn(async () => {});
    await seq.run("b", second);
    expect(second).toHaveBeenCalledTimes(1);
  });

  // A throw must not wedge the flag, or one failed attempt would block every future
  // reconnect — including the watchdog's.
  it("clears the flag when a sequence throws, and reports the failure", async () => {
    const errors: string[] = [];
    const seq = createReconnectSequencer({ log: { error: (m) => errors.push(m) } });
    await seq.run("boom", async () => {
      throw new Error("connect failed");
    });
    expect(seq.isInFlight()).toBe(false);
    expect(errors[0]).toContain("boom");
    expect(errors[0]).toContain("connect failed");
  });
});

describe("buildWatchdogPredicate", () => {
  const allClear = {
    isStopped: () => false,
    isReconnectInFlight: () => false,
    isConnectingOrConnected: () => false,
    hasPendingReconnect: () => false,
    isRefreshingToken: () => false,
    hasDeferredReconnect: () => false,
  };

  it("says yes only when nobody at all is managing the connection", () => {
    expect(buildWatchdogPredicate(allClear)()).toBe(true);
  });

  // Every one of these is on its own sufficient to veto. The in-flight one is the least
  // obvious and the reason the sequencer exists: a deferred reconnect callback clears its
  // own handle first and then awaits a teardown that also clears the socket's state, so
  // for the length of that await every other signal here reads "nobody is doing anything".
  it.each([
    ["the account is stopping", { isStopped: () => true }],
    ["a sequence is mid-await", { isReconnectInFlight: () => true }],
    ["a socket is already connecting", { isConnectingOrConnected: () => true }],
    ["the socket's own backoff is scheduled", { hasPendingReconnect: () => true }],
    ["a token refresh is running", { isRefreshingToken: () => true }],
    ["a deferred reconnect is queued", { hasDeferredReconnect: () => true }],
  ])("says no while %s", (_name, override) => {
    expect(buildWatchdogPredicate({ ...allClear, ...override })()).toBe(false);
  });

  it("re-reads the state on every call rather than capturing it", () => {
    let connecting = true;
    const predicate = buildWatchdogPredicate({
      ...allClear,
      isConnectingOrConnected: () => connecting,
    });
    expect(predicate()).toBe(false);
    connecting = false;
    expect(predicate()).toBe(true);
  });
});

describe("createDeferredReconnect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (over: Partial<Parameters<typeof createDeferredReconnect>[0]> = {}) => {
    const run = vi.fn(async () => {});
    const sequencer = createReconnectSequencer();
    const deferred = createDeferredReconnect({
      isStopped: () => false,
      sequencer,
      run,
      delayMs: () => 1_000,
      ...over,
    });
    return { deferred, run, sequencer };
  };

  it("runs the sequence after the delay, not before", async () => {
    const { deferred, run } = make();
    deferred.schedule("cooldown");
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // This is the property the outage turned on: something has to be armed, and it has to be
  // visible to whoever else might step in.
  it("reports itself as pending only while armed", async () => {
    const { deferred } = make();
    expect(deferred.isPending()).toBe(false);
    deferred.schedule("cooldown");
    expect(deferred.isPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deferred.isPending()).toBe(false);
  });

  it("keeps one handle when scheduled twice", async () => {
    const { deferred, run } = make();
    deferred.schedule("a");
    deferred.schedule("b");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled before it fires", async () => {
    const { deferred, run } = make();
    deferred.schedule("cooldown");
    deferred.cancel();
    expect(deferred.isPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not arm anything for a stopped account", async () => {
    const { deferred, run } = make({ isStopped: () => true });
    deferred.schedule("cooldown");
    expect(deferred.isPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
  });

  // Scheduled while running, stopped while waiting: firing anyway would build a connection
  // for an account that is already shutting down.
  it("does not run if the account stopped while it waited", async () => {
    let stopped = false;
    const { deferred, run } = make({ isStopped: () => stopped });
    deferred.schedule("cooldown");
    stopped = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("goes through the sequencer so the watchdog sees it", async () => {
    let release: (() => void) | undefined;
    const { deferred, sequencer } = make({
      run: () => new Promise<void>((res) => (release = res)),
    });
    deferred.schedule("cooldown");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sequencer.isInFlight()).toBe(true);
    release?.();
  });
});

describe("createSingleFlightFlag", () => {
  it("is raised for the duration of the work and lowered after", async () => {
    const flag = createSingleFlightFlag();
    let release: (() => void) | undefined;
    expect(flag.isRaised()).toBe(false);

    const running = flag.run(() => new Promise<void>((res) => (release = res)));
    expect(flag.isRaised()).toBe(true);

    release?.();
    await running;
    expect(flag.isRaised()).toBe(false);
  });

  // The trap this unit exists for. Raising the flag and then handing the work to something
  // that may decline to run it — a sequencer already busy with another sequence — used to
  // leave the flag raised forever, because the lowering lived inside the work.
  it("lowers the flag even when the work does nothing at all", async () => {
    const flag = createSingleFlightFlag();
    await flag.run(async () => {
      /* declined: the callback never ran anything */
    });
    expect(flag.isRaised()).toBe(false);
  });

  it("lowers the flag when the work throws", async () => {
    const flag = createSingleFlightFlag();
    await expect(
      flag.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(flag.isRaised()).toBe(false);
  });

  it("can be raised again after the previous run finished", async () => {
    const flag = createSingleFlightFlag();
    await flag.run(async () => {});
    let seen = false;
    await flag.run(async () => {
      seen = flag.isRaised();
    });
    expect(seen).toBe(true);
    expect(flag.isRaised()).toBe(false);
  });
});
