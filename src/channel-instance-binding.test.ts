import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OctoApiError } from "./api-error.js";
import {
  BOT_INSTANCE_CONFLICT_CODE,
  BOT_INSTANCE_CONFLICT_MESSAGE,
} from "./instance-id.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  disconnectAndWait: vi.fn(async () => {}),
  registerBot: vi.fn(),
  socketOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  registerSessionBindingAdapter: vi.fn(),
  unregisterSessionBindingAdapter: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(),
}));

vi.mock("./instance-id.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrCreateInstanceId: vi.fn(async () => "550e8400-e29b-41d4-a716-446655440000"),
}));

vi.mock("./socket.js", () => ({
  WKSocket: class {
    constructor(options: Record<string, unknown>) {
      mocks.socketOptions = options;
    }
    connect() { mocks.connect(); }
    disconnect() { mocks.disconnect(); }
    disconnectAndWait() { return mocks.disconnectAndWait(); }
    stopReconnectTimer() {}
    updateCredentials() {}
    isConnected() { return false; }
    isConnectingOrConnected() { return false; }
    hasPendingReconnect() { return false; }
  },
}));

vi.mock("./events-poll.js", () => ({
  startEventPoller: () => ({ ready: Promise.resolve(), stop: vi.fn(), cursor: () => 0 }),
  setCardEventPollStarter: vi.fn(),
  requestCardEventPolling: vi.fn(),
  createFileEventCursorStore: () => ({ load: async () => 0, save: async () => {} }),
}));

vi.mock("./api-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerBot: (...args: unknown[]) => mocks.registerBot(...args),
  sendHeartbeat: vi.fn(async () => {}),
  fetchBotGroups: vi.fn(async () => []),
  getGroupMembers: vi.fn(async () => []),
  getGroupMd: vi.fn(async () => ({ content: "", version: 0 })),
}));

function conflict(): OctoApiError {
  return OctoApiError.from(
    { status: 409 },
    "/v1/bot/register",
    JSON.stringify({ error: { code: BOT_INSTANCE_CONFLICT_CODE } }),
  );
}

function context(controller: AbortController, status: ReturnType<typeof vi.fn>) {
  return {
    account: {
      accountId: "acct1",
      enabled: true,
      configured: true,
      config: {
        botToken: "bf_token",
        apiUrl: "https://octo.test",
        heartbeatIntervalMs: 60_000,
      },
    },
    cfg: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setStatus: status,
    abortSignal: controller.signal,
  } as never;
}

describe("channel instance binding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.connect.mockClear();
    mocks.disconnect.mockClear();
    mocks.disconnectAndWait.mockClear();
    mocks.registerBot.mockReset();
    mocks.socketOptions = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails before creating a WebSocket when initial registration conflicts", async () => {
    mocks.registerBot.mockRejectedValueOnce(conflict());
    const { octoPlugin } = await import("./channel.js");
    const status = vi.fn();
    const controller = new AbortController();

    await expect(octoPlugin.gateway!.startAccount!(context(controller, status)))
      .rejects.toThrow(BOT_INSTANCE_CONFLICT_MESSAGE);

    expect(mocks.socketOptions).toBeUndefined();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      lastError: BOT_INSTANCE_CONFLICT_MESSAGE,
    }));
  });

  it("permanently blocks reconnect after a refresh registration conflict", async () => {
    mocks.registerBot
      .mockResolvedValueOnce({
        robot_id: "bot_1",
        im_token: "im_1",
        ws_url: "ws://octo.test/ws",
        owner_uid: "owner_1",
      })
      .mockRejectedValueOnce(conflict());
    const { octoPlugin } = await import("./channel.js");
    const status = vi.fn();
    const controller = new AbortController();
    const running = octoPlugin.gateway!.startAccount!(context(controller, status));
    await vi.advanceTimersByTimeAsync(0);

    const onError = mocks.socketOptions?.onError as ((err: Error) => Promise<void>) | undefined;
    expect(onError).toBeTypeOf("function");
    await onError!(new Error("Kicked by server"));
    await vi.advanceTimersByTimeAsync(180_000);

    expect(mocks.registerBot).toHaveBeenCalledTimes(2);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.disconnect).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      running: false,
      lastError: BOT_INSTANCE_CONFLICT_MESSAGE,
    }));

    controller.abort();
    await running;
  });
});
