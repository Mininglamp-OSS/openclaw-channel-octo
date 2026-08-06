import { describe, expect, it, vi } from "vitest";

import { buildWatchdogPredicate, createReconnectSequencer } from "./reconnect-coordination.js";

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
