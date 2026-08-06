import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Own mock socket rather than the one in reconnect-fixes.test.ts: that suite replaces
 * global.setTimeout with a recorder that never fires, which is incompatible with the fake
 * clock these tests need. Keeping the harness local also means the connection states this
 * file exercises cannot disturb the twenty-odd tests over there.
 */
vi.mock("ws", () => {
  class MockWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    binaryType = "arraybuffer";
    /** Starts in CONNECTING; the test decides when (or whether) it opens. */
    readyState = 0;
    closed = false;
    private handlers = new Map<string, Function[]>();

    constructor(public url: string) {
      (globalThis as any).__mockWsInstances?.push(this);
    }

    on(event: string, handler: Function) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(handler);
    }

    send = vi.fn();

    /** Move to OPEN and fire `open`, the way a real upgrade completes. */
    complete() {
      this.readyState = 1;
      this.emit("open");
    }

    close() {
      this.closed = true;
      this.readyState = 3;
      queueMicrotask(() => this.emit("close"));
    }

    terminate() {
      this.close();
    }

    emit(event: string, ...args: any[]) {
      for (const h of this.handlers.get(event) ?? []) h(...args);
    }
  }

  return { default: MockWS, WebSocket: MockWS };
});

vi.mock("curve25519-js", () => ({
  generateKeyPair: () => ({ private: new Uint8Array(32), public: new Uint8Array(32) }),
  sharedKey: () => new Uint8Array(32),
}));

import { CONNECT_DEADLINE_MS, WKSocket } from "./socket.js";

function buildConnackPacket(reasonCode: number): ArrayBuffer {
  const serverVersion = 4;
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
  return new Uint8Array([header, body.length, ...body]).buffer;
}

const instances: any[] = [];

function createSocket(overrides: Partial<ConstructorParameters<typeof WKSocket>[0]> = {}) {
  return new WKSocket({
    wsUrl: "ws://test:5200",
    uid: "bot1",
    token: "tok1",
    onMessage: vi.fn(),
    ...overrides,
  });
}

describe("connection build-up deadline", () => {
  beforeEach(() => {
    instances.length = 0;
    (globalThis as any).__mockWsInstances = instances;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).__mockWsInstances;
    vi.restoreAllMocks();
  });

  // `connected`, the ping timer and the stability timer all start only after a successful
  // CONNACK. A build-up that stalls before that produces no close event and no ping
  // timeout, so without a deadline nothing in the process ever notices — and the
  // watchdog's isConnectingOrConnected() predicate would deliberately stay out of the way.
  it("closes a socket that never leaves CONNECTING", async () => {
    const socket = createSocket();
    socket.connect();
    expect(instances[0].readyState).toBe(0);
    expect(socket.isConnectingOrConnected()).toBe(true);
    expect(socket.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS + 1);

    expect(instances[0].closed).toBe(true);
  });

  it("closes a socket that opened but never got CONNACK", async () => {
    const socket = createSocket();
    socket.connect();
    instances[0].complete(); // upgrade done, CONNECT sent, then silence
    expect(instances[0].readyState).toBe(1);
    expect(socket.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS + 1);

    expect(instances[0].closed).toBe(true);
  });

  it("leaves a healthy connection alone once CONNACK arrives", async () => {
    const socket = createSocket();
    socket.connect();
    instances[0].complete();
    instances[0].emit("message", buildConnackPacket(1));
    expect(socket.isConnected()).toBe(true);

    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS * 2);

    expect(instances[0].closed).toBe(false);
  });

  // A deadline armed for one socket must not reach across and close its replacement.
  it("does not let a stale deadline close a newer socket", async () => {
    const socket = createSocket();
    socket.connect(); // instances[0]
    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS / 2);
    socket.connect(); // instances[1] replaces it mid-build-up
    instances[1].complete();
    instances[1].emit("message", buildConnackPacket(1));

    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS);

    expect(instances[1].closed).toBe(false);
  });

  it("drops the deadline when the caller disconnects", async () => {
    const socket = createSocket();
    socket.connect();
    const ws = instances[0];
    socket.disconnect();
    ws.closed = false; // ignore the close disconnect() itself performed

    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS * 2);

    expect(ws.closed).toBe(false);
  });

  it("drops the deadline after disconnectAndWait", async () => {
    const socket = createSocket();
    socket.connect();
    const ws = instances[0];
    await socket.disconnectAndWait(0);
    ws.closed = false;

    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS * 2);

    expect(ws.closed).toBe(false);
  });

  // The branch N2 fixed. A CONNACK reporting a failed connect used to leave the socket OPEN
  // and non-null, so readyState claimed somebody was still connecting and the supervisor
  // stayed out of the way forever.
  it("closes and drops the socket when CONNACK reports a failed connect", async () => {
    const onError = vi.fn();
    const socket = createSocket({ onError });
    socket.connect();
    instances[0].complete();
    instances[0].emit("message", buildConnackPacket(2)); // neither success nor kicked

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Connect failed") }),
    );
    expect(instances[0].closed).toBe(true);
    expect(socket.isConnectingOrConnected()).toBe(false);
    expect(socket.isConnected()).toBe(false);
  });

  it("drops the deadline on a rejected CONNACK", async () => {
    const onError = vi.fn();
    const socket = createSocket({ onError });
    socket.connect();
    instances[0].complete();
    instances[0].emit("message", buildConnackPacket(0)); // kicked
    const ws = instances[0];
    ws.closed = false;

    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS * 2);

    expect(onError).toHaveBeenCalled();
    expect(ws.closed).toBe(false);
  });
});

describe("connection state accessors", () => {
  beforeEach(() => {
    instances.length = 0;
    (globalThis as any).__mockWsInstances = instances;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).__mockWsInstances;
    vi.restoreAllMocks();
  });

  // Two questions that are easy to conflate and must not be: "can this carry traffic?"
  // (after CONNACK, for anything reporting liveness) versus "is somebody building this
  // connection?" (readyState, for staying out of the way).
  it("separates 'connected' from 'connecting or connected'", () => {
    const socket = createSocket();
    expect(socket.isConnected()).toBe(false);
    expect(socket.isConnectingOrConnected()).toBe(false);

    socket.connect();
    expect(socket.isConnected()).toBe(false); // CONNECTING is not usable
    expect(socket.isConnectingOrConnected()).toBe(true);

    instances[0].complete();
    expect(socket.isConnected()).toBe(false); // OPEN without CONNACK is not usable either
    expect(socket.isConnectingOrConnected()).toBe(true);

    instances[0].emit("message", buildConnackPacket(1));
    expect(socket.isConnected()).toBe(true);
    expect(socket.isConnectingOrConnected()).toBe(true);
  });

  // The reconnect handle is one of the watchdog's predicates. Leaving it set after the
  // timer fired would make "a reconnect is already pending" permanently true and silence
  // the watchdog for the lifetime of the process.
  it("reports no pending reconnect once the timer has fired", async () => {
    const socket = createSocket();
    socket.connect();
    instances[0].complete();
    instances[0].emit("message", buildConnackPacket(1));
    expect(socket.hasPendingReconnect()).toBe(false);

    instances[0].emit("close");
    await Promise.resolve();
    expect(socket.hasPendingReconnect()).toBe(true);

    // Past the first backoff plus its jitter ceiling.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.hasPendingReconnect()).toBe(false);
  });

  it("reports no pending reconnect after the timer is cancelled", async () => {
    const socket = createSocket();
    socket.connect();
    instances[0].complete();
    instances[0].emit("message", buildConnackPacket(1));
    instances[0].emit("close");
    await Promise.resolve();
    expect(socket.hasPendingReconnect()).toBe(true);

    socket.stopReconnectTimer();
    expect(socket.hasPendingReconnect()).toBe(false);
  });
});
