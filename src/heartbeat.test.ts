import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OctoApiError } from "./api-error.js";
import { HEARTBEAT_TIMEOUT_MS, MAX_HEARTBEAT_FAILURES, createHeartbeatLoop } from "./heartbeat.js";

const rateLimitError = () =>
  OctoApiError.from({ status: 429, headers: { get: () => null } }, "/v1/bot/heartbeat", "");

type Params = Parameters<typeof createHeartbeatLoop>[0];

describe("createHeartbeatLoop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (over: Partial<Params> = {}) => {
    const warns: string[] = [];
    const errors: string[] = [];
    const loop = createHeartbeatLoop({
      intervalMs: 1_000,
      accountId: "bot",
      send: vi.fn(async () => {}),
      isConnected: () => true,
      log: { warn: (m) => warns.push(m), error: (m) => errors.push(m) },
      ...over,
    });
    return { loop, warns, errors };
  };

  it("beats on every interval while connected", async () => {
    const send = vi.fn(async () => {});
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(3_000);
    loop.stop();
    expect(send).toHaveBeenCalledTimes(3);
  });

  // Reporting "I am alive" while the socket is down would be a lie, and nothing reads the
  // beat urgently enough to justify sending it anyway.
  it("skips the beat while the socket is down", async () => {
    const send = vi.fn(async () => {});
    const { loop } = make({ send, isConnected: () => false });
    loop.start();
    await vi.advanceTimersByTimeAsync(3_000);
    loop.stop();
    expect(send).not.toHaveBeenCalled();
  });

  // Rate limiting is not a liveness failure. Counting it would eventually trip a threshold
  // whose only historical effect was tearing down a healthy connection.
  it("does not count a 429 as a failure", async () => {
    const send = vi.fn(async () => {
      throw rateLimitError();
    });
    const { loop, warns, errors } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(5_000);
    loop.stop();
    expect(send).toHaveBeenCalledTimes(5);
    expect(errors).toHaveLength(0);
    expect(warns.some((m) => m.includes("rate limited"))).toBe(true);
    expect(warns.every((m) => !m.includes("/3"))).toBe(true);
  });

  it("reports the rate-limit scope and remaining count when the server sends them", async () => {
    const send = vi.fn(async () => {
      throw OctoApiError.from(
        {
          status: 429,
          headers: {
            get: (n: string) =>
              n.toLowerCase() === "x-ratelimit-scope"
                ? "ip"
                : n.toLowerCase() === "x-ratelimit-remaining"
                  ? "0"
                  : null,
          },
        },
        "/v1/bot/heartbeat",
        "",
      );
    });
    const { loop, warns } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    expect(warns[0]).toContain("scope=ip");
    expect(warns[0]).toContain("remaining=0");
  });

  it("escalates to error only after enough real failures", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const { loop, warns, errors } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(MAX_HEARTBEAT_FAILURES * 1_000);
    loop.stop();
    expect(warns).toHaveLength(MAX_HEARTBEAT_FAILURES - 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`(${MAX_HEARTBEAT_FAILURES}/${MAX_HEARTBEAT_FAILURES})`);
  });

  it("resets the failure count after a success", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      if (calls === 2) return; // fail, succeed, fail, fail...
      throw new Error("boom");
    });
    const { loop, errors } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(4_000);
    loop.stop();
    // Without the reset the fourth beat would be failure three and escalate.
    expect(errors).toHaveLength(0);
  });

  // A hung request must not stack beats on top of each other.
  it("does not start a second beat while one is in flight", async () => {
    const send = vi.fn(() => new Promise<void>(() => {}));
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(3_000);
    loop.stop();
    expect(send).toHaveBeenCalledTimes(1);
  });

  // ...and it must not hold the single-flight slot forever. `fetch` has no default
  // timeout, so this deadline is the only thing that frees the slot.
  it("times a hung beat out and frees the slot", async () => {
    let aborts = 0;
    const send = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborts++;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    expect(aborts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(2); // slot freed, next beat went out
    loop.stop();
  });

  it("clears the deadline when a beat completes normally", async () => {
    let aborted = false;
    const send = vi.fn(async (signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
    });
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS * 2);
    loop.stop();
    // A leaked deadline would abort a signal whose request already finished.
    expect(aborted).toBe(false);
  });

  it("aborts the in-flight beat on stop", async () => {
    let aborted = false;
    const send = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    expect(aborted).toBe(true);
  });

  it("stops beating after stop", async () => {
    const send = vi.fn(async () => {});
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on repeated start", async () => {
    const send = vi.fn(async () => {});
    const { loop } = make({ send });
    loop.start();
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("can be restarted after a stop", async () => {
    const send = vi.fn(async () => {});
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
