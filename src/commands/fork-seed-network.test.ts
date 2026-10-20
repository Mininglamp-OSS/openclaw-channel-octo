import { afterEach, expect, it, vi } from "vitest";
import { setOctoRuntime } from "../runtime.js";
import { dispatchForkSeedReply } from "./fork-inbound.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it.each([false, true])("fork seed native deadline aborts a hanging fetch after retry (released=%s)", async released => {
  // Exercise the real sendMessage/requestJson path and native abort events.
  // Scale only the caller's 30s budget; the transport's 60s ceiling stays real.
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => nativeTimeout(ms === 30_000 ? 100 : ms));
  const sends: string[] = [];
  let aborted = false;
  globalThis.fetch = vi.fn(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/v1/bot/sendMessage");
    const content = JSON.parse(String(init?.body)).payload.content as string;
    sends.push(content);
    if (content === "首条问题处理失败，请在此子区重试。") return Response.json({ message_id: "notice" });
    if (sends.length === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0.001" } });
    const signal = init?.signal;
    expect(signal).toBeDefined();
    return new Promise<Response>((_, reject) => {
      const onAbort = () => { aborted = true; reject(signal!.reason); };
      if (signal!.aborted) onAbort();
      else signal!.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
  setOctoRuntime({
    channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "child", accountId: "acct" }) },
      reply: {
        finalizeInboundContext: (ctx: unknown) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: async (opts: any) => {
          await opts.dispatcherOptions.deliver({ text: "answer" }, { kind: "final" });
        },
      },
    },
  } as never);
  const running = dispatchForkSeedReply({
    seedCtx: { ParentSessionKey: "parent" } as never,
    childChannelId: "group____child", accountId: "acct",
    account: { config: { dispatchTimeoutMs: released ? 5 : 1_000 } } as never,
    apiUrl: "https://api.test", botToken: "test-token", config: {} as never,
  });
  if (released) {
    await running;
    await vi.waitFor(() => expect(sends).toContain("首条问题处理失败，请在此子区重试。"), { timeout: 1_000 });
  } else await expect(running).rejects.toThrow(/delivery failed/);
  expect(aborted).toBe(true);
  expect(sends).toEqual(["answer", "answer", ...(released ? ["首条问题处理失败，请在此子区重试。"] : [])]);
  // A retry must retain the original caller deadline, not allocate a fresh
  // 30s budget per attempt. This fails if sendSeedText stops passing its signal.
  expect(timeout.mock.calls.filter(([ms]) => ms === 30_000)).toHaveLength(released ? 2 : 1);
}, 2_000);
