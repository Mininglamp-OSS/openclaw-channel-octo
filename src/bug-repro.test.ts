/**
 * Bug fix verification tests for WebSocket reconnect v2 (Issue #139)
 *
 * These tests verify that three bugs have been FIXED:
 *   Bug A: Exponential backoff now works (reconnectAttempts not reset prematurely)
 *   Bug B: Kicked bots reconnect even during cooldown window
 *   Bug C: Rapid silent disconnects now trigger onError for token refresh
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track mock WS instances created during tests
const mockWsInstances: any[] = [];

vi.mock("ws", () => {
  class MockWS {
    static OPEN = 1;
    binaryType = "arraybuffer";
    readyState = 1;
    private handlers = new Map<string, Function[]>();

    constructor(public url: string) {
      (globalThis as any).__mockWsInstances?.push(this);
    }

    on(event: string, handler: Function) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(handler);
    }

    send = vi.fn();

    close() {
      this.readyState = 3; // CLOSED
      queueMicrotask(() => this.emit("close"));
    }

    emit(event: string, ...args: any[]) {
      const handlers = this.handlers.get(event);
      if (handlers) {
        for (const h of handlers) h(...args);
      }
    }
  }

  return { default: MockWS, WebSocket: MockWS };
});

vi.mock("curve25519-js", () => ({
  generateKeyPair: () => ({
    private: new Uint8Array(32),
    public: new Uint8Array(32),
  }),
  sharedKey: () => new Uint8Array(32),
}));

import { WKSocket } from "./socket.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal CONNACK packet with reasonCode=1 (success) */
function buildConnackSuccess(): ArrayBuffer {
  const serverVersion = 4;
  const reasonCode = 1; // success
  const serverKey = Buffer.from(new Uint8Array(32)).toString("base64");
  const salt = "1234567890123456";

  const body: number[] = [];
  body.push(serverVersion);
  for (let i = 0; i < 8; i++) body.push(0); // timeDiff
  body.push(reasonCode);
  const keyBytes = [...Buffer.from(serverKey)];
  body.push((keyBytes.length >> 8) & 0xff, keyBytes.length & 0xff);
  body.push(...keyBytes);
  const saltBytes = [...Buffer.from(salt)];
  body.push((saltBytes.length >> 8) & 0xff, saltBytes.length & 0xff);
  body.push(...saltBytes);
  for (let i = 0; i < 8; i++) body.push(0); // nodeId

  const header = (2 << 4) | 1; // CONNACK with hasServerVersion
  const packet = new Uint8Array([header, body.length, ...body]);
  return packet.buffer;
}

/** Build a CONNACK packet with reasonCode=0 (kicked) */
function buildConnackKicked(): ArrayBuffer {
  const serverVersion = 4;
  const reasonCode = 0; // kicked

  const body: number[] = [];
  body.push(serverVersion);
  for (let i = 0; i < 8; i++) body.push(0); // timeDiff
  body.push(reasonCode);
  // serverKey (empty)
  body.push(0, 0);
  // salt (empty)
  body.push(0, 0);
  for (let i = 0; i < 8; i++) body.push(0); // nodeId

  const header = (2 << 4) | 1;
  const packet = new Uint8Array([header, body.length, ...body]);
  return packet.buffer;
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe("Bug A fix: Exponential backoff grows correctly", () => {
  let setTimeoutCalls: { fn: Function; delay: number }[];
  let originalSetTimeout: typeof setTimeout;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockWsInstances.length = 0;
    (globalThis as any).__mockWsInstances = mockWsInstances;
    setTimeoutCalls = [];
    originalSetTimeout = global.setTimeout;
    global.setTimeout = vi.fn((fn: Function, delay?: number) => {
      setTimeoutCalls.push({ fn, delay: delay ?? 0 });
      return 999 as any;
    }) as any;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    dateNowSpy?.mockRestore();
    delete (globalThis as any).__mockWsInstances;
    vi.restoreAllMocks();
  });

  it("delays should GROW after 5 connect→CONNACK→close cycles", () => {
    /**
     * With the fix, reconnectAttempts only resets after the 30s stable timer
     * fires (which requires the connection to stay up for 30s). Connections
     * that live <30s keep the backoff counter, so delays grow exponentially.
     *
     * We mock Date.now so each connection appears to last 6s (>5s threshold)
     * to isolate Bug A from Bug C's rapid-disconnect detection.
     */
    let now = 10000;
    dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    const socket = new WKSocket({
      wsUrl: "ws://test:5200",
      uid: "bot1",
      token: "tok1",
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });

    const reconnectDelays: number[] = [];

    for (let cycle = 0; cycle < 5; cycle++) {
      socket.connect();
      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.emit("open");

      // CONNACK success → sets lastConnectTime = now, starts stable timer
      ws.emit("message", buildConnackSuccess());

      // Advance time by 6s (above 5s rapid-disconnect threshold,
      // but well below the 30s stable timer)
      now += 6000;

      setTimeoutCalls = [];
      ws.emit("close");

      // The only setTimeout from the close handler is scheduleReconnect
      if (setTimeoutCalls.length > 0) {
        reconnectDelays.push(setTimeoutCalls[0].delay);
      }
    }

    // All 5 cycles should have produced reconnect delays
    expect(reconnectDelays).toHaveLength(5);

    // Delays should strictly increase (exponential backoff working)
    for (let i = 1; i < reconnectDelays.length; i++) {
      expect(reconnectDelays[i]).toBeGreaterThan(reconnectDelays[i - 1]);
    }

    // First delay ~3000ms (base), with ±25% jitter → [2250, 3750]
    expect(reconnectDelays[0]).toBeGreaterThanOrEqual(2250);
    expect(reconnectDelays[0]).toBeLessThanOrEqual(4500);

    // Last delay should be much larger (~48000ms at attempt 4)
    expect(reconnectDelays[4]).toBeGreaterThan(20000);

    socket.disconnect();
  });
});


// "Kicked during cooldown still reconnects" used to live here as a hand-copied onError with
// local variables. It reset its refresh flag synchronously, so no amount of exercising it could
// have caught the real implementation leaving that flag stuck on — the defect a reviewer found
// by reading the production code instead. Deleted rather than repaired: the behaviour it claimed
// to protect is covered against real code in reconnect-coordination.test.ts (a deferred
// reconnect is armed, cancellable, visible, and skipped for a stopped account).


describe("Bug C fix: Rapid silent disconnects trigger onError", () => {
  it("onError fires after 3 consecutive rapid disconnects", () => {
    /**
     * With the fix, the close handler tracks rapid disconnects (connections
     * lasting <5s). After 3 consecutive rapid disconnects, it calls onError
     * with "Connect failed: rapid disconnect detected" so channel.ts can
     * refresh the token.
     */
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = vi.fn((fn: Function, delay?: number) => {
      return 999 as any;
    }) as any;

    mockWsInstances.length = 0;
    (globalThis as any).__mockWsInstances = mockWsInstances;

    const onError = vi.fn();
    const socket = new WKSocket({
      wsUrl: "ws://test:5200",
      uid: "bot1",
      token: "tok1",
      onMessage: vi.fn(),
      onError,
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });

    // Simulate 3 rapid connect→CONNACK→immediate-close cycles
    // (connection lasting <5s each time, simulating server restart)
    for (let i = 0; i < 3; i++) {
      socket.connect();
      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.emit("open");
      ws.emit("message", buildConnackSuccess());
      // Connection closes immediately (server restart, no Kicked packet)
      ws.emit("close");
    }

    // FIX VERIFIED: onError IS called after 3 rapid disconnects
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Connect failed: rapid disconnect detected",
    }));

    socket.disconnect();
    global.setTimeout = originalSetTimeout;
    delete (globalThis as any).__mockWsInstances;
    vi.restoreAllMocks();
  });

  it("rapid-disconnect loop with stale token triggers onError for refresh", () => {
    /**
     * Simulates the production scenario: server restarts, bot reconnects with
     * stale token, server silently closes again. After 3 such cycles, onError
     * fires so channel.ts can refresh the token.
     */
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = vi.fn((fn: Function, delay?: number) => {
      return 999 as any;
    }) as any;

    mockWsInstances.length = 0;
    (globalThis as any).__mockWsInstances = mockWsInstances;

    const onError = vi.fn();
    const socket = new WKSocket({
      wsUrl: "ws://test:5200",
      uid: "bot1",
      token: "stale-token",
      onMessage: vi.fn(),
      onError,
    });

    // 3 rapid connect→close cycles (simulating stale token scenario)
    for (let i = 0; i < 3; i++) {
      socket.connect();
      const ws = mockWsInstances[mockWsInstances.length - 1];
      ws.emit("open");
      ws.emit("message", buildConnackSuccess());
      ws.emit("close");
    }

    // FIX VERIFIED: After 3 short-lived connections, onError fires
    // This allows channel.ts to refresh the token
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Connect failed: rapid disconnect detected",
    }));

    socket.disconnect();
    global.setTimeout = originalSetTimeout;
    delete (globalThis as any).__mockWsInstances;
    vi.restoreAllMocks();
  });
});
