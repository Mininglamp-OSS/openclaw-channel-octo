# 插件侧 429 限流韧性 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 逐任务实现（本仓库这轮不派 subagent）。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 让插件被服务端限流（429）时表现得当 —— 不再把心跳失败当掉线去拆 WebSocket，不再在服务端给出的冷却窗口内反复撞，且任何失败路径都不能让适配器永久假死。

**Architecture:** 三层。底层 `src/api-error.ts` 把 HTTP 错误结构化（状态码 / `Retry-After` / `X-RateLimit-*`）；中层 `postJson` 成为**唯一**的 429 退避所有者，其余调用点要么显式弃权（`retryOn429: false`）要么不自己重试；上层把心跳与 WebSocket 生命周期解耦，并用一个监督者 + 三个既存缺口修复保证连接总能自愈。

**Tech Stack:** TypeScript strict, ESM, Node ≥ 22, vitest。

**Spec:** `docs/superpowers/specs/2026-08-06-rate-limit-resilience-design.md`（已定稿，逐条对应到下面的任务）。

## Global Constraints

- Node ≥ 22，ESM，`"type": "module"` —— 相对 import **必须带 `.js` 后缀**（`./api-error.js`），即使源文件是 `.ts`。
- TypeScript strict。不新增依赖；**禁止** import `node:child_process`（ClawScan 会拒装）。
- 测试与实现同目录：`src/x.ts` ↔ `src/x.test.ts`。
- 不改 `src/version.ts`（由 `prebuild` 生成）。
- 代码注释只写长期有用的技术理由，**不写**评审过程 / 工具名 / AI 署名 / `Co-Authored-By`。commit message 同样。
- 每个任务结束前跑 `npx vitest run <该任务的测试文件>`；最后一个任务跑全量。
- 常量集中定义，不散写字面量。本计划引入：`MAX_429_RETRIES = 2`、`MAX_RETRY_AFTER_MS = 10_000`、`MAX_429_BACKOFF_WAIT_MS = 15_000`、`DEFAULT_RETRY_AFTER_MS = 1_000`、`HEARTBEAT_TIMEOUT_MS = 10_000`、`CONNECT_DEADLINE_MS = 15_000`、`WATCHDOG_INTERVAL_MS = 60_000`。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/api-error.ts`（新） | `OctoApiError` + 从 `Response` 解析状态 / `Retry-After` / `X-RateLimit-*` |
| `src/api-error.test.ts`（新） | 上者的解析与兼容契约 |
| `src/api-fetch.ts`（改） | `postJson` 加 429 退避与 `retryOn429`；`httpStatusFromApiFetchError` 优先读 `.status`；各调用点弃权 |
| `src/heartbeat.ts`（新） | 心跳循环：单飞、每拍超时、429 不计失败、绝不碰 WS |
| `src/heartbeat.test.ts`（新） | 上者 |
| `src/connection-watchdog.ts`（新） | 定期检查"该重连但没人管"并拉起 |
| `src/connection-watchdog.test.ts`（新） | 上者 |
| `src/socket.ts`（改） | `reconnectTimer` 触发即置 null；两个只读访问器；建连 deadline |
| `src/channel.ts`（改） | 接线心跳与监督者；`reconnectInFlight` + `runReconnectSequence`；补 `registerBot` 失败后的重连 |
| `src/card-progress.ts`（改） | 429 退出本地重试；flush 路径弃权；按 apiUrl 的冷却门 |
| `src/reconnect-fixes.test.ts`（改） | 改写记录了旧心跳契约的用例 |
| `src/card-progress.test.ts`（改） | 补 mock 的 `headers`；拆开 429/503；冷却门用例 |
| `src/events-poll.test.ts`（改） | 锁死事件轮询不受内部退避干扰 |

---

### Task 1: `OctoApiError` —— 结构化 API 错误

**Files:**
- Create: `src/api-error.ts`
- Create: `src/api-error.test.ts`
- Modify: `src/api-fetch.ts:55-73`（`httpStatusFromApiFetchError` 优先读 `.status`）

**Interfaces:**
- Consumes: 无（最底层）。
- Produces: `class OctoApiError extends Error`，字段 `status: number`、`path: string`、`body: string`、`retryAfterMs: number`、`rateLimitScope?: string`、`rateLimitRemaining?: string`，getter `isRateLimited: boolean`；静态 `OctoApiError.from(resp: ResponseLike, path: string, body: string): OctoApiError`。常量 `DEFAULT_RETRY_AFTER_MS = 1_000`。

- [ ] **Step 1: 写失败测试**

`src/api-error.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { OctoApiError, DEFAULT_RETRY_AFTER_MS } from "./api-error.js";
import { httpStatusFromApiFetchError } from "./api-fetch.js";

const resp = (status: number, headers: Record<string, string> = {}) => ({
  status,
  statusText: "err",
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
});

describe("OctoApiError.from", () => {
  it("prefers the Retry-After header over the body hint", () => {
    const err = OctoApiError.from(
      resp(429, { "retry-after": "3" }),
      "/v1/bot/heartbeat",
      JSON.stringify({ error: { details: { retry_after: 9 } } }),
    );
    expect(err.retryAfterMs).toBe(3_000);
  });

  it("falls back to the body hint when the header is absent", () => {
    const err = OctoApiError.from(
      resp(429),
      "/v1/bot/heartbeat",
      JSON.stringify({ error: { details: { retry_after: 2 } } }),
    );
    expect(err.retryAfterMs).toBe(2_000);
  });

  it("defaults when neither is present", () => {
    const err = OctoApiError.from(resp(429), "/v1/bot/heartbeat", "");
    expect(err.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });

  // 解析层不得截断：把服务端的「300 秒后再来」改写成更短的等待就是提前重试，
  // 而提前重试正是这次故障要消掉的行为。上限只在重试决策处用。
  it("keeps a large but legal Retry-After verbatim", () => {
    const err = OctoApiError.from(resp(429, { "retry-after": "300" }), "/p", "");
    expect(err.retryAfterMs).toBe(300_000);
  });

  it.each(["abc", "-5", "Wed, 21 Oct 2026 07:28:00 GMT"])(
    "falls back to the default for the unusable value %s",
    (raw) => {
      const err = OctoApiError.from(resp(429, { "retry-after": raw }), "/p", "");
      expect(err.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
    },
  );

  it("carries the rate-limit diagnostics", () => {
    const err = OctoApiError.from(
      resp(429, { "x-ratelimit-scope": "ip", "x-ratelimit-remaining": "0" }),
      "/p",
      "",
    );
    expect(err.rateLimitScope).toBe("ip");
    expect(err.rateLimitRemaining).toBe("0");
    expect(err.isRateLimited).toBe(true);
  });

  it("is not rate limited for other statuses", () => {
    expect(OctoApiError.from(resp(500), "/p", "").isRateLimited).toBe(false);
  });

  // Response-like mock 与非标准实现可能没有 headers。读头不能把一个正常的
  // 错误路径变成 TypeError。
  it("tolerates a response without headers", () => {
    const err = OctoApiError.from({ status: 429, statusText: "err" }, "/p", "");
    expect(err.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });

  // 现有 API_FETCH_STATUS_RE 从 message 正则解析状态码，card-progress 与
  // fork-inherit-md 都依赖这个格式。
  it("keeps the message format the existing status parser expects", () => {
    const err = OctoApiError.from(resp(429), "/v1/bot/heartbeat", "nope");
    expect(err.message).toBe("Octo API /v1/bot/heartbeat failed (429): nope");
    expect(httpStatusFromApiFetchError(err)).toBe(429);
  });
});

describe("httpStatusFromApiFetchError", () => {
  it("reads .status directly off an OctoApiError", () => {
    const err = OctoApiError.from(resp(503), "/p", "");
    expect(httpStatusFromApiFetchError(err)).toBe(503);
  });

  it("still parses the legacy message format", () => {
    expect(httpStatusFromApiFetchError(new Error("Octo API /p failed (404): x"))).toBe(404);
  });

  it("returns undefined without a status", () => {
    expect(httpStatusFromApiFetchError(new Error("network down"))).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/api-error.test.ts`
Expected: FAIL — `Cannot find module './api-error.js'`

- [ ] **Step 3: 实现 `src/api-error.ts`**

```ts
/**
 * Structured error for the Octo REST helpers.
 *
 * The status code and the server's rate-limit hints used to survive only as text
 * inside the message, so every caller that needed them re-parsed the string. This
 * carries them as fields while keeping the historical message format, which an
 * existing regex parser and its callers still depend on.
 */

/** Fallback wait when the server rate-limits without a usable hint. */
export const DEFAULT_RETRY_AFTER_MS = 1_000;

/** The subset of `Response` this module reads, so tests and non-standard bodies both fit. */
export interface ResponseLike {
  status: number;
  statusText?: string;
  headers?: { get?(name: string): string | null };
}

function header(resp: ResponseLike, name: string): string | undefined {
  // Optional all the way down: a hand-rolled response object may carry no headers
  // at all, and reading them must never turn a plain HTTP failure into a TypeError.
  const raw = resp.headers?.get?.(name);
  return raw == null || raw === "" ? undefined : raw;
}

/** Seconds → ms, rejecting anything that is not a finite non-negative number (HTTP-date included). */
function secondsToMs(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function retryAfterFromBody(body: string): number | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { details?: { retry_after?: unknown } } };
    const hint = parsed?.error?.details?.retry_after;
    return secondsToMs(typeof hint === "number" || typeof hint === "string" ? hint : undefined);
  } catch {
    return undefined;
  }
}

export class OctoApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;
  /**
   * The server's requested wait, verbatim. Deliberately not clamped here: shortening
   * it would mean retrying earlier than the server asked, which is the behaviour this
   * whole change exists to remove. Callers decide whether the wait is worth honouring.
   */
  readonly retryAfterMs: number;
  readonly rateLimitScope?: string;
  readonly rateLimitRemaining?: string;

  constructor(params: {
    status: number;
    path: string;
    body: string;
    retryAfterMs: number;
    rateLimitScope?: string;
    rateLimitRemaining?: string;
  }) {
    super(`Octo API ${params.path} failed (${params.status}): ${params.body}`);
    this.name = "OctoApiError";
    this.status = params.status;
    this.path = params.path;
    this.body = params.body;
    this.retryAfterMs = params.retryAfterMs;
    this.rateLimitScope = params.rateLimitScope;
    this.rateLimitRemaining = params.rateLimitRemaining;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  static from(resp: ResponseLike, path: string, body: string): OctoApiError {
    return new OctoApiError({
      status: resp.status,
      path,
      body: body || resp.statusText || "",
      retryAfterMs:
        secondsToMs(header(resp, "Retry-After")) ??
        retryAfterFromBody(body) ??
        DEFAULT_RETRY_AFTER_MS,
      rateLimitScope: header(resp, "X-RateLimit-Scope"),
      rateLimitRemaining: header(resp, "X-RateLimit-Remaining"),
    });
  }
}
```

- [ ] **Step 4: 让 `httpStatusFromApiFetchError` 优先读 `.status`**

`src/api-fetch.ts` —— 在文件顶部 import 区加：

```ts
import { OctoApiError } from "./api-error.js";
```

把 `httpStatusFromApiFetchError`（`:69-73`）函数体改为：

```ts
export function httpStatusFromApiFetchError(err: unknown): number | undefined {
  // OctoApiError carries the status as a field; the regex stays for errors thrown
  // by the helpers in this module that do not build one, and for anything older.
  if (err instanceof OctoApiError) return err.status;
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(API_FETCH_STATUS_RE);
  return match ? Number(match[1]) : undefined;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/api-error.test.ts && npx vitest run src/api-fetch.test.ts && npm run type-check`
Expected: PASS（`api-fetch.test.ts` 是回归，必须仍绿）

- [ ] **Step 6: Commit**

```bash
git add src/api-error.ts src/api-error.test.ts src/api-fetch.ts
git commit -m "feat(api): carry HTTP status and rate-limit hints on a structured error"
```

---

### Task 2: `postJson` 的 429 退避（唯一所有者）

**Files:**
- Modify: `src/api-fetch.ts:75-105`（`postJson`）
- Test: `src/api-fetch.test.ts`（扩充）

**Interfaces:**
- Consumes: Task 1 的 `OctoApiError`、`DEFAULT_RETRY_AFTER_MS`。
- Produces: `postJson<T>(apiUrl, botToken, path, payload, signal?, opts?: { retryOn429?: boolean }): Promise<T | undefined>`；导出常量 `MAX_429_RETRIES`、`MAX_RETRY_AFTER_MS`、`MAX_429_BACKOFF_WAIT_MS`。

- [ ] **Step 1: 写失败测试**

追加到 `src/api-fetch.test.ts`（用假时钟，别真睡）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postJson, MAX_RETRY_AFTER_MS } from "./api-fetch.js";
import { OctoApiError } from "./api-error.js";

describe("postJson 429 backoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const rateLimited = (retryAfter = "1") => ({
    ok: false, status: 429, statusText: "too many",
    headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? retryAfter : null) },
    text: async () => "rate limited",
  });
  const ok = (body = "{}") => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => body,
  });

  it("retries after the server's wait and returns the retry's result", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok('{"a":1}'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const promise = postJson("https://x.test", "bf", "/v1/bot/sendMessage", {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await promise).toEqual({ a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a structured error once the retries are spent", async () => {
    global.fetch = vi.fn().mockResolvedValue(rateLimited()) as unknown as typeof fetch;
    const promise = postJson("https://x.test", "bf", "/p", {});
    const assertion = expect(promise).rejects.toMatchObject({ status: 429, retryAfterMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("does not retry a non-429", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: "boom",
      headers: { get: () => null }, text: async () => "boom",
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(postJson("https://x.test", "bf", "/p", {})).rejects.toBeInstanceOf(OctoApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the caller opts out", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited());
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      postJson("https://x.test", "bf", "/p", {}, undefined, { retryOn429: false }),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Retry-After is the earliest acceptable retry time, so jitter may only add.
  it("never waits less than the server asked", async () => {
    for (let i = 0; i < 100; i++) {
      const fetchMock = vi.fn().mockResolvedValueOnce(rateLimited("2")).mockResolvedValueOnce(ok());
      global.fetch = fetchMock as unknown as typeof fetch;
      const promise = postJson("https://x.test", "bf", "/p", {});
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting at 1999ms
      await vi.advanceTimersByTimeAsync(2_501);   // 2000 * 1.25 + slack
      await promise;
    }
  });

  it("gives up instead of shortening a wait beyond the cap", async () => {
    const tooLong = String(MAX_RETRY_AFTER_MS / 1000 + 5);
    const fetchMock = vi.fn().mockResolvedValue(rateLimited(tooLong));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(postJson("https://x.test", "bf", "/p", {})).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts mid-backoff and keeps the rate-limit error as the cause", async () => {
    global.fetch = vi.fn().mockResolvedValue(rateLimited("5")) as unknown as typeof fetch;
    const controller = new AbortController();
    const promise = postJson("https://x.test", "bf", "/p", {}, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({
      cause: expect.objectContaining({ status: 429 }),
    });
    controller.abort(new Error("caller gone"));
    await assertion;
  });

  it("does not fetch at all when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      postJson("https://x.test", "bf", "/p", {}, AbortSignal.abort()),
    ).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies a default deadline when the caller passes no signal", async () => {
    let seen: AbortSignal | undefined;
    global.fetch = vi.fn(async (_u: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return ok();
    }) as unknown as typeof fetch;
    await postJson("https://x.test", "bf", "/p", {});
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  // A long poll asks for a deadline well past the default. Intersecting the two
  // would cut the hold short and discard the batch the server was about to send.
  it("uses the caller's signal verbatim rather than intersecting it", async () => {
    const callerSignal = AbortSignal.timeout(40_000);
    let seen: AbortSignal | undefined;
    global.fetch = vi.fn(async (_u: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return ok();
    }) as unknown as typeof fetch;
    await postJson("https://x.test", "bf", "/p", {}, callerSignal);
    expect(seen).toBe(callerSignal);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/api-fetch.test.ts -t "429 backoff"`
Expected: FAIL —— 现在 429 不重试、`retryOn429` 参数不存在、抛的是普通 `Error`

- [ ] **Step 3: 实现**

`src/api-fetch.ts`，在常量区（`:12` 附近）加：

```ts
/** At most three attempts per call: the original plus two retries. */
export const MAX_429_RETRIES = 2;
/**
 * A wait longer than this is not worth holding the call for. Used only to decide
 * whether to retry — never to shorten the server's requested wait, because a
 * shortened wait means retrying before the server said we could.
 */
export const MAX_RETRY_AFTER_MS = 10_000;
/** Cumulative backoff sleep budget for one call. Not an end-to-end deadline. */
export const MAX_429_BACKOFF_WAIT_MS = 15_000;
```

加一个可中断的 sleep（放在 `postJson` 之前）：

```ts
/** Sleep that rejects as soon as the caller's signal aborts, preserving `cause`. */
function backoffSleep(ms: number, signal: AbortSignal | undefined, cause: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      // Surface the rate limiting as the cause; without it the site of failure
      // only shows a generic abort and the 429 diagnosis is lost.
      reject(new Error(`aborted while backing off from a rate limit`, { cause }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

把 `postJson` 整体替换为：

```ts
export async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: { retryOn429?: boolean },
): Promise<T | undefined> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const retryOn429 = opts?.retryOn429 ?? true;
  let waited = 0;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason;

    // Rebuilt per attempt: a deadline created once outside the loop would be shared
    // across attempts, so a retry could start already expired. When the caller passed
    // a signal we use it as-is — it knows how long this particular request may take
    // (the events long poll deliberately asks for far more than the default), and
    // intersecting it with a generic deadline would cut such a request short.
    const fetchSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${botToken}` },
      body: JSON.stringify(payload),
      signal: fetchSignal,
    });

    if (response.ok) {
      const text = await response.text();
      if (!text) return undefined;
      try {
        return parseOctoJson<T>(text);
      } catch {
        throw new Error(`Octo API ${path} returned invalid JSON: ${text.slice(0, 200)}`);
      }
    }

    const body = await response.text().catch(() => "");
    const err = OctoApiError.from(response, path, body);

    if (err.isRateLimited) {
      console.warn(
        `octo: rate limited on ${path} (scope=${err.rateLimitScope ?? "?"} ` +
          `remaining=${err.rateLimitRemaining ?? "?"} retry_after=${err.retryAfterMs}ms) ` +
          `attempt=${attempt + 1}/${retryOn429 ? MAX_429_RETRIES + 1 : 1}`,
      );
    }

    if (!err.isRateLimited || !retryOn429 || attempt >= MAX_429_RETRIES) throw err;
    if (err.retryAfterMs > MAX_RETRY_AFTER_MS) throw err;

    // Jitter only ever adds. Retry-After is the earliest acceptable retry time, so a
    // downward jitter would put us back on the server before it said we could.
    const delay = Math.round(err.retryAfterMs * (1 + Math.random() * 0.25));
    if (waited + delay > MAX_429_BACKOFF_WAIT_MS) throw err;

    await backoffSleep(delay, signal, err);
    waited += delay;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/api-fetch.test.ts && npm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api-fetch.ts src/api-fetch.test.ts
git commit -m "feat(api): back off once per call on 429, never earlier than Retry-After"
```

---

### Task 3: 让不该重试的调用点弃权

**Files:**
- Modify: `src/api-fetch.ts:816`（`sendTyping`）、`:831`（`sendReadReceipt`）、`:843`（`sendHeartbeat`）、`:779`（`fetchBotEvents`）、`:799`（`ackBotEvent`）
- Test: `src/api-fetch.test.ts`、`src/events-poll.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `opts.retryOn429`。
- Produces: 无新接口 —— 只改这五个调用点的行为。

- [ ] **Step 1: 写失败测试**

追加到 `src/api-fetch.test.ts`：

```ts
describe("callers that opt out of the shared 429 backoff", () => {
  const rateLimited = () => ({
    ok: false, status: 429, statusText: "too many",
    headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "1" : null) },
    text: async () => "rate limited",
  });

  // Each of these has its own cadence — a periodic beat, a discardable hint, or a
  // poller with outcome-based pacing — so a hidden sleep inside the call is wrong.
  it.each([
    ["sendHeartbeat", () => sendHeartbeat({ apiUrl: "https://x.test", botToken: "bf" })],
    ["sendTyping", () => sendTyping({ apiUrl: "https://x.test", botToken: "bf", channelId: "g", channelType: 2 })],
    ["sendReadReceipt", () => sendReadReceipt({ apiUrl: "https://x.test", botToken: "bf", channelId: "g", channelType: 2, messageIds: ["1"] })],
    ["fetchBotEvents", () => fetchBotEvents({ apiUrl: "https://x.test", botToken: "bf", cursor: 0 })],
    ["ackBotEvent", () => ackBotEvent({ apiUrl: "https://x.test", botToken: "bf", eventId: "e1" })],
  ])("%s issues exactly one request on 429", async (_name, call) => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited());
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(call()).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

追加到 `src/events-poll.test.ts`（沿用该文件已有的 poller 搭建方式）：

```ts
// The poller decides whether the server really held by measuring elapsed time around
// the whole request. A backoff sleep inside the request inflates that measurement, so
// an empty fast return would read as an honoured hold and re-poll at 0ms — the hot loop
// the outcome-based pacing exists to prevent.
it("keeps a 429 from inflating the measured hold", async () => {
  // 断言：429 时只发一次请求，且下一次 tick 的间隔走错误退避（≥ intervalMs），不是 0ms。
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/api-fetch.test.ts -t "opt out"`
Expected: FAIL —— 现在这五个都会重试到 3 次

- [ ] **Step 3: 实现**

五处 `postJson` 调用各加最后一个参数。`sendHeartbeat`（`:843`）：

```ts
  // A missed beat costs nothing: the next one is 30s away, and no server-side reader
  // consumes the heartbeat key. Sleeping inside the call would only add pressure to a
  // bucket that is already empty.
  await postJson(params.apiUrl, params.botToken, "/v1/bot/heartbeat", {}, params.signal, {
    retryOn429: false,
  });
```

`sendTyping`（`:816`）与 `sendReadReceipt`（`:831`）同样加 `{ retryOn429: false }`，注释写"discardable hint, retrying only adds pressure"。

`fetchBotEvents`（`:779`）与 `ackBotEvent`（`:799`）加 `{ retryOn429: false }`，注释：

```ts
  // The poll loop paces itself from the outcome of each request, including an
  // exponential backoff on errors. It also infers "did the server hold?" from the
  // elapsed time, which a sleep inside this call would corrupt.
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/api-fetch.test.ts src/events-poll.test.ts && npm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api-fetch.ts src/api-fetch.test.ts src/events-poll.test.ts
git commit -m "feat(api): opt periodic and self-paced callers out of the 429 backoff"
```

---

### Task 4: `src/heartbeat.ts` —— 心跳与 WebSocket 解耦

**Files:**
- Create: `src/heartbeat.ts`
- Create: `src/heartbeat.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OctoApiError`。
- Produces: `createHeartbeatLoop(params: { intervalMs: number; accountId: string; send: (signal: AbortSignal) => Promise<void>; isConnected: () => boolean; log?: { warn?(m: string): void; error?(m: string): void } }): { start(): void; stop(): void }`；常量 `HEARTBEAT_TIMEOUT_MS = 10_000`、`MAX_HEARTBEAT_FAILURES = 3`。

- [ ] **Step 1: 写失败测试**

`src/heartbeat.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatLoop, HEARTBEAT_TIMEOUT_MS } from "./heartbeat.js";
import { OctoApiError } from "./api-error.js";

const rateLimitError = () =>
  OctoApiError.from({ status: 429, headers: { get: () => null } }, "/v1/bot/heartbeat", "");

describe("createHeartbeatLoop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (over: Partial<Parameters<typeof createHeartbeatLoop>[0]> = {}) => {
    const errors: string[] = [];
    const warns: string[] = [];
    const loop = createHeartbeatLoop({
      intervalMs: 1_000,
      accountId: "bot",
      send: vi.fn(async () => {}),
      isConnected: () => true,
      log: { warn: (m) => warns.push(m), error: (m) => errors.push(m) },
      ...over,
    });
    return { loop, errors, warns };
  };

  it("skips the beat while the socket is down", async () => {
    const send = vi.fn(async () => {});
    const { loop } = make({ send, isConnected: () => false });
    loop.start();
    await vi.advanceTimersByTimeAsync(3_000);
    loop.stop();
    expect(send).not.toHaveBeenCalled();
  });

  // Rate limiting is not a liveness failure. Counting it would eventually trip a
  // threshold whose only historical effect was tearing down a healthy connection.
  it("does not count a 429 as a failure", async () => {
    const send = vi.fn(async () => { throw rateLimitError(); });
    const { loop, errors, warns } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(5_000);
    loop.stop();
    expect(send).toHaveBeenCalledTimes(5);
    expect(errors).toHaveLength(0);
    expect(warns.some((m) => m.includes("rate limited"))).toBe(true);
  });

  it("logs after enough real failures and never touches the socket", async () => {
    const send = vi.fn(async () => { throw new Error("boom"); });
    const { loop, errors } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(3_000);
    loop.stop();
    expect(errors.length).toBeGreaterThan(0);
    // Nothing in this module can reach the socket: no dependency is injected for it.
  });

  it("resets the failure count after a success", async () => {
    let calls = 0;
    const send = vi.fn(async () => { calls++; if (calls !== 2) throw new Error("boom"); });
    const { loop, errors } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(3_000);
    loop.stop();
    // Two failures separated by a success never reach the threshold of three.
    expect(errors.every((m) => !m.includes("(3/3)"))).toBe(true);
  });

  // A hung request must not stack beats on top of each other, and must not hold the
  // single-flight slot forever.
  it("does not overlap beats and times a hung request out", async () => {
    let resolveHang: (() => void) | undefined;
    const send = vi.fn((signal: AbortSignal) =>
      new Promise<void>((_res, rej) => {
        resolveHang = () => rej(new Error("aborted"));
        signal.addEventListener("abort", () => rej(new Error("timed out")), { once: true });
      }),
    );
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(send).toHaveBeenCalledTimes(1); // still in flight, no second beat
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(2); // slot freed after the timeout
    resolveHang?.();
    loop.stop();
  });

  it("aborts the in-flight request on stop", async () => {
    let aborted = false;
    const send = vi.fn((signal: AbortSignal) =>
      new Promise<void>(() => { signal.addEventListener("abort", () => { aborted = true; }); }),
    );
    const { loop } = make({ send });
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();
    expect(aborted).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/heartbeat.test.ts`
Expected: FAIL — `Cannot find module './heartbeat.js'`

- [ ] **Step 3: 实现 `src/heartbeat.ts`**

```ts
/**
 * Periodic liveness beat for a bot account.
 *
 * Deliberately has no access to the WebSocket. The beat is a REST call; its failure
 * says nothing about whether the socket is healthy, and treating it as a connection
 * fault used to tear down a working connection and strand the account. The socket
 * has its own ping/pong and reconnect machinery for its own health.
 *
 * The loop's lifetime follows the account, not the connection, so it cannot be left
 * stopped by a reconnect that never completes.
 */

import { OctoApiError } from "./api-error.js";

/** Per-beat deadline. `fetch` has no default timeout, so without this a hung
 *  connection would hold the single-flight slot indefinitely. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** Consecutive non-rate-limit failures before the log escalates to error. */
export const MAX_HEARTBEAT_FAILURES = 3;

export interface HeartbeatLoop {
  start(): void;
  stop(): void;
}

export function createHeartbeatLoop(params: {
  intervalMs: number;
  accountId: string;
  send: (signal: AbortSignal) => Promise<void>;
  isConnected: () => boolean;
  log?: { warn?(msg: string): void; error?(msg: string): void };
}): HeartbeatLoop {
  const { intervalMs, accountId, send, isConnected, log } = params;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: AbortController | undefined;
  let consecutiveFailures = 0;
  let stopped = false;

  const beat = (): void => {
    if (stopped || inFlight) return; // single-flight: never stack beats
    // Reporting "I am alive" while the socket is down would be a lie, and nothing
    // reads the beat urgently enough to justify sending it anyway.
    if (!isConnected()) return;

    const controller = new AbortController();
    inFlight = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS)]);

    void send(signal)
      .then(() => { consecutiveFailures = 0; })
      .catch((err: unknown) => {
        if (err instanceof OctoApiError && err.isRateLimited) {
          // Transient by definition and self-correcting: the next beat is one interval
          // away. Counting it would conflate "the server is busy" with "we are offline".
          log?.warn?.(
            `octo: [${accountId}] heartbeat rate limited ` +
              `(scope=${err.rateLimitScope ?? "?"} remaining=${err.rateLimitRemaining ?? "?"}), skipping this beat`,
          );
          return;
        }
        consecutiveFailures++;
        const msg = `octo: [${accountId}] heartbeat failed (${consecutiveFailures}/${MAX_HEARTBEAT_FAILURES}): ${String(err)}`;
        if (consecutiveFailures >= MAX_HEARTBEAT_FAILURES) log?.error?.(msg);
        else log?.warn?.(msg);
      })
      .finally(() => { if (inFlight === controller) inFlight = undefined; });
  };

  return {
    start(): void {
      if (timer) return;
      stopped = false;
      timer = setInterval(beat, intervalMs);
    },
    stop(): void {
      stopped = true;
      if (timer) { clearInterval(timer); timer = undefined; }
      inFlight?.abort(new Error("heartbeat stopped"));
      inFlight = undefined;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/heartbeat.test.ts && npm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat.ts src/heartbeat.test.ts
git commit -m "feat(heartbeat): extract a loop that cannot reach the socket"
```

---

### Task 5: `socket.ts` 的三处修复与访问器

**Files:**
- Modify: `src/socket.ts:255-266`（字段）、`:343-353`（`doConnect` 起 deadline）、`:388-422`（close 清理）、`:432-453`（`reconnectTimer` 置 null）、`:620-659`（`onConnack` 清理）、`:294-338`（`disconnect` / `disconnectAndWait`）、`:714-725`（`onDisconnect`）
- Test: `src/reconnect-fixes.test.ts`（新增真实 `WKSocket` 用例）

**Interfaces:**
- Consumes: 无。
- Produces: `WKSocket` 新增 `isConnectingOrConnected(): boolean`、`hasPendingReconnect(): boolean`；常量 `CONNECT_DEADLINE_MS = 15_000`。

- [ ] **Step 1: 写失败测试**

追加到 `src/reconnect-fixes.test.ts`：

```ts
// 建连全程（CONNECTING → OPEN → CONNACK）都要有 deadline。connected 只在 CONNACK 之后
// 才置真、心跳定时器也只在那时才起，所以卡在这两段里都不会有 close 事件、也不会有 ping
// 超时把连接救回来 —— 没有 deadline 就是永久挂住。
it("closes a connection stuck before CONNACK", async () => {
  // 用一个永不 open 的假 WebSocket 起 socket.connect()，推进 CONNECT_DEADLINE_MS，
  // 断言 close 被调用、且随后排了重连。
});

it("closes a connection that opened but never got CONNACK", async () => {
  // 假 WebSocket 触发 open 后不回 CONNACK，推进 CONNECT_DEADLINE_MS，断言同上。
});

// 旧 socket 的 deadline 到点时不得关掉刚建好的新连接。
it("does not let a stale connect deadline close a newer socket", async () => { /* ... */ });

// hasPendingReconnect 是 watchdog 的谓词之一。定时器触发后若句柄仍非 null，
// 谓词会永久为真，watchdog 被永久哑掉。
it("reports no pending reconnect once the timer has fired", async () => { /* ... */ });

it("reports CONNECTING as connecting-or-connected", async () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/reconnect-fixes.test.ts`
Expected: FAIL —— 无 deadline、无访问器

- [ ] **Step 3: 实现**

字段区（`:266` 后）加：

```ts
  /** Deadline for the whole connection build-up, see startConnectDeadline. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
```

文件常量区加：

```ts
/**
 * Bound on the entire build-up: TCP/Upgrade, then the CONNECT packet, then CONNACK.
 * `connected`, the heartbeat and the stability timer all start only after CONNACK, so
 * a build-up that stalls anywhere before that produces no close event and no ping
 * timeout — nothing else would ever notice.
 */
const CONNECT_DEADLINE_MS = 15_000;
```

`doConnect()` 里，替换旧 socket 之后、新建 `WebSocket` 之后：

```ts
    this.clearConnectDeadline(); // the socket being replaced took its deadline with it
    // ... const ws = new WebSocket(...) ...
    this.startConnectDeadline(ws);
```

新增两个私有方法：

```ts
  private startConnectDeadline(ws: WebSocket): void {
    this.clearConnectDeadline();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      // Bound to the socket that created it: a stale deadline must never close a
      // connection established after it was scheduled.
      if (this.ws !== ws) return;
      console.debug("[WKSocket] connect deadline expired before CONNACK, closing");
      try { ws.close(); } catch { /* ignore */ }
      // The close handler takes it from here: needReconnect is still true, so it
      // schedules a reconnect through the normal backoff path.
    }, CONNECT_DEADLINE_MS);
  }

  private clearConnectDeadline(): void {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
  }
```

清除点：在 `disconnect()`（`:299` 的 `stopHeart()` 旁）、`disconnectAndWait()`（`:312` 旁）、ws `close` handler（`:398` 的 `stopHeart()` 旁）、`onDisconnect()`（`:720` 旁）各加 `this.clearConnectDeadline();`；`onConnack()` 里在读完包、进入三个 `reasonCode` 分支**之前**加一次 `this.clearConnectDeadline();`（一处覆盖全部分支）。

`scheduleReconnect()` 的回调（`:441-445`）改为：

```ts
    this.reconnectTimer = setTimeout(() => {
      // Cleared on entry: leaving the handle set makes "a reconnect is already
      // pending" permanently true, which silences anything that consults it.
      this.reconnectTimer = null;
      if (this.needReconnect) {
        this.doConnect();
      }
    }, delay);
```

新增两个公开访问器（放在 `disconnectAndWait` 之后）：

```ts
  /** True while a socket exists and is either connecting or open. */
  isConnectingOrConnected(): boolean {
    const state = this.ws?.readyState;
    return state === WebSocket.CONNECTING || state === WebSocket.OPEN;
  }

  /** True while a backoff reconnect is scheduled but has not fired. */
  hasPendingReconnect(): boolean {
    return this.reconnectTimer !== null;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/reconnect-fixes.test.ts src/socket.test.ts && npm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/socket.ts src/reconnect-fixes.test.ts
git commit -m "fix(socket): bound the connection build-up and stop pinning the reconnect handle"
```

---

### Task 6: `src/connection-watchdog.ts` —— 兵底监督者

**Files:**
- Create: `src/connection-watchdog.ts`
- Create: `src/connection-watchdog.test.ts`

**Interfaces:**
- Consumes: 无（谓词与重连动作都由调用方注入）。
- Produces: `createConnectionWatchdog(params: { intervalMs?: number; accountId: string; shouldReconnect: () => boolean; reconnect: () => void | Promise<void>; log?: { warn?(m: string): void } }): { start(): void; stop(): void }`；常量 `WATCHDOG_INTERVAL_MS = 60_000`。

- [ ] **Step 1: 写失败测试**

`src/connection-watchdog.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionWatchdog, WATCHDOG_INTERVAL_MS } from "./connection-watchdog.js";

describe("createConnectionWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (shouldReconnect: () => boolean) => {
    const reconnect = vi.fn();
    const dog = createConnectionWatchdog({
      intervalMs: 1_000, accountId: "bot", shouldReconnect, reconnect,
    });
    return { dog, reconnect };
  };

  it("revives a connection nobody else is managing", async () => {
    const { dog, reconnect } = make(() => true);
    dog.start();
    await vi.advanceTimersByTimeAsync(2_000);
    dog.stop();
    expect(reconnect).toHaveBeenCalled();
  });

  it("stays out of the way when the predicate says no", async () => {
    const { dog, reconnect } = make(() => false);
    dog.start();
    await vi.advanceTimersByTimeAsync(5_000);
    dog.stop();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not check after stop", async () => {
    const shouldReconnect = vi.fn(() => false);
    const { dog } = make(shouldReconnect);
    dog.start();
    dog.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(shouldReconnect).not.toHaveBeenCalled();
  });

  // The revive is async; a second tick must not stack another one on top of it.
  it("does not overlap revives", async () => {
    let release: (() => void) | undefined;
    const reconnect = vi.fn(() => new Promise<void>((res) => { release = res; }));
    const dog = createConnectionWatchdog({
      intervalMs: 1_000, accountId: "bot", shouldReconnect: () => true, reconnect,
    });
    dog.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    release?.();
    dog.stop();
  });

  it("exports a default interval", () => {
    expect(WATCHDOG_INTERVAL_MS).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/connection-watchdog.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `src/connection-watchdog.ts`**

```ts
/**
 * Last-resort supervisor for an account's WebSocket.
 *
 * Individual failure paths are fixed where they are found, but each fix only covers
 * the path it knows about. This asks one question on a slow timer — "should something
 * be reconnecting, and is nobody doing it?" — so a path that is missed, or added
 * later, still recovers instead of stranding the account until a manual restart.
 *
 * The predicate lives with the caller because only it can see every piece of
 * reconnect state. Getting that predicate wrong causes duplicate connections that
 * kick each other, so it must account for every in-progress and scheduled attempt.
 */

/** Slow on purpose: this is a backstop, not the primary recovery path. */
export const WATCHDOG_INTERVAL_MS = 60_000;

export interface ConnectionWatchdog {
  start(): void;
  stop(): void;
}

export function createConnectionWatchdog(params: {
  intervalMs?: number;
  accountId: string;
  shouldReconnect: () => boolean;
  reconnect: () => void | Promise<void>;
  log?: { warn?(msg: string): void };
}): ConnectionWatchdog {
  const { accountId, shouldReconnect, reconnect, log } = params;
  const intervalMs = params.intervalMs ?? WATCHDOG_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reviving = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || reviving) return;
    if (!shouldReconnect()) return;
    reviving = true;
    log?.warn?.(`octo: [${accountId}] connection looks stranded with nobody reconnecting, reviving`);
    void (async () => {
      try {
        await reconnect();
      } catch (err) {
        log?.warn?.(`octo: [${accountId}] watchdog revive failed: ${String(err)}`);
      } finally {
        reviving = false;
      }
    })();
  };

  return {
    start(): void {
      if (timer) return;
      stopped = false;
      // Jitter the period so accounts in one process do not all check in lockstep.
      const jittered = Math.round(intervalMs * (0.75 + Math.random() * 0.5));
      timer = setInterval(tick, jittered);
    },
    stop(): void {
      stopped = true;
      if (timer) { clearInterval(timer); timer = undefined; }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/connection-watchdog.test.ts && npm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/connection-watchdog.ts src/connection-watchdog.test.ts
git commit -m "feat(socket): add a supervisor that revives a stranded connection"
```

---

### Task 7: `channel.ts` 接线 —— 心跳、监督者、重连序列

**Files:**
- Modify: `src/channel.ts:1405-1434`（删内联心跳，接 `createHeartbeatLoop`）、`:1610-1621`（`onConnected` / `onDisconnected` 不再管心跳）、`:1623-1682`（`onError` 包 `runReconnectSequence`、补 `registerBot` 失败后的重连）、`:1466-1468`（删 `consecutiveHeartbeatFailures`）、`:1688-1700`（cleanup 停心跳与监督者）
- Test: `src/reconnect-fixes.test.ts`、`src/channel.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `createHeartbeatLoop`、Task 5 的 `isConnectingOrConnected` / `hasPendingReconnect`、Task 6 的 `createConnectionWatchdog`。
- Produces: 无导出变化。

- [ ] **Step 1: 写失败测试**

追加到 `src/reconnect-fixes.test.ts`：

```ts
// 重连序列执行中这个状态今天在代码里没有任何表示。cooldown 回调先把自己的句柄置 null，
// 再 await disconnectAndWait()，而后者同步清掉 ws、needReconnect 和 socket 的重连定时器 ——
// 那个 await 期间所有「有人在管重连」的迹象都消失了，监督者会并发建第二条连接。
it("keeps the watchdog out while a reconnect sequence is mid-await", async () => { /* ... */ });

it("re-checks stopped after each await in a reconnect sequence", async () => { /* ... */ });

// registerBot 在限流风暴里同样会 429。此前 catch 只打一行日志就结束，留下
// needReconnect=false、无定时器、心跳已停 —— 进程活着但永久假死。
it("schedules a reconnect after a failed re-register", async () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/reconnect-fixes.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

import 区加：

```ts
import { createHeartbeatLoop } from "./heartbeat.js";
import { createConnectionWatchdog } from "./connection-watchdog.js";
```

删除 `:1406-1434` 的 `heartbeatTimer` / `startHeartbeat`，以及 `:1466-1468` 的 `consecutiveHeartbeatFailures` / `MAX_HEARTBEAT_FAILURES`。

在 `socket` 构造**之后**加（`socket` 是谓词与 sender 的依赖，所以必须在其后）：

```ts
      // Lifetime follows the account, not the connection: the loop used to be
      // restartable only from onConnected, so a reconnect that never completed left
      // the beat stopped for good.
      const heartbeat = createHeartbeatLoop({
        intervalMs: account.config.heartbeatIntervalMs,
        accountId: account.accountId,
        send: (signal) =>
          sendHeartbeat({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, signal }),
        isConnected: () => socket.isConnectingOrConnected(),
        log,
      });

      // One boolean, not a state machine: it represents "a reconnect sequence is
      // running right now", which no existing field captures. Without it the
      // watchdog can slip into the middle of a sequence that has already torn the
      // old socket down but not yet built the new one.
      let reconnectInFlight = false;
      const runReconnectSequence = async (label: string, fn: () => Promise<void>): Promise<void> => {
        if (reconnectInFlight) return;
        reconnectInFlight = true;
        try {
          await fn();
        } catch (err) {
          log?.error?.(`octo: [${account.accountId}] reconnect sequence ${label} failed: ${String(err)}`);
        } finally {
          reconnectInFlight = false;
        }
      };

      const watchdog = createConnectionWatchdog({
        accountId: account.accountId,
        log,
        shouldReconnect: () =>
          !stopped &&
          !reconnectInFlight &&
          !socket.isConnectingOrConnected() &&
          !socket.hasPendingReconnect() &&
          !isRefreshingToken &&
          cooldownReconnectTimer === null,
        reconnect: () =>
          runReconnectSequence("watchdog", async () => {
            await socket.disconnectAndWait();
            if (stopped) return;
            socket.stopReconnectTimer();
            socket.connect();
          }),
      });
```

`onConnected`（`:1610`）删掉 `startHeartbeat()`；`onDisconnected`（`:1617`）删掉清心跳那行。

`onError` 的 token 刷新分支整体包进 `runReconnectSequence("token-refresh", async () => { ... })`，并把 `registerBot` 的 catch 改为：

```ts
            } catch (refreshErr) {
              log?.error?.(`octo: [${account.accountId}] token refresh failed: ${String(refreshErr)}`);
              // Returning here used to end the story: needReconnect was already false
              // and the socket's own timer had been cleared, so nothing was left to try
              // again. Under a rate-limit storm /v1/bot/register is exactly as likely to
              // fail as the call that got us here.
              if (!stopped) {
                const retryMs = 5_000 + Math.floor(Math.random() * 5_000);
                setTimeout(() => {
                  if (!stopped) socket.connect();
                }, retryMs);
              }
            }
```

cooldown 分支的回调包进 `runReconnectSequence("cooldown", ...)`，并在 `await` 之后补 `stopped` 复查：

```ts
            cooldownReconnectTimer = setTimeout(() => {
              cooldownReconnectTimer = null;
              void runReconnectSequence("cooldown", async () => {
                if (stopped) return;
                await socket.disconnectAndWait();
                if (stopped) return; // the account can stop while we wait above
                socket.stopReconnectTimer();
                socket.connect();
              });
            }, backoffMs);
```

`socket.connect()`（`:1685`）之后加 `heartbeat.start(); watchdog.start();`；cleanup（`:1689-1700`）里加 `heartbeat.stop(); watchdog.stop();`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/reconnect-fixes.test.ts src/channel.test.ts && npm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/channel.ts src/reconnect-fixes.test.ts
git commit -m "fix(channel): keep the beat off the socket and leave no unmanaged reconnect"
```

---

### Task 8: `card-progress.ts` —— 退出 429 重试 + 冷却门

**Files:**
- Modify: `src/card-progress.ts:407-418`（`isRetryableRegistryEditError`）、`:435-448`（`editTemplateCardWithRetry`）、`:452-653`（`runFlush` 前置冷却检查、429 记冷却）、`:364-371`（`scheduleFlush` 旁加到期唤醒）
- Test: `src/card-progress.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OctoApiError`、Task 2 的 `opts.retryOn429`。
- Produces: 模块内部的 `rateLimitedUntil: Map<string, number>` 与 `noteRateLimited(apiUrl, retryAfterMs)` / `cooldownRemainingMs(apiUrl)`（仅本文件用，测试通过公开行为断言）。

- [ ] **Step 1: 写失败测试**

修 `:879-918` 与 `:2659-2681` 两处 mock（**两处都缺 `headers`，postJson 一读 `Retry-After` 就 `TypeError`**），给失败响应加 `headers: { get: () => null }`；并把 `:879` 的 `it.each([429, 503])` 拆成两个 `it` —— 429 与 503 的路径已经分岔。

新增：

```ts
describe("progress frames under rate limiting", () => {
  // 进度帧是可丢弃的中间帧。在 flush 里睡着等退避会占住单飞位、把后面的帧一起拖住，
  // 代价大于收益 —— 丢掉这一帧、等下一个事件重渲染更划算。
  it("sends a rate-limited transient frame exactly once and does not disable the card", async () => { /* ... */ });

  it("drops the frame when no further event arrives", async () => { /* ... */ });

  it("renders the next frame normally once a new event arrives", async () => { /* ... */ });

  // 光不重试还不够：只要事件持续到来，去抖 flush 会每 ~800ms 发一个新 edit，
  // 正好在服务端刚给出的冷却窗口里反复撞。
  it("emits no transient edit inside the cooldown window", async () => { /* ... */ });

  it("sends only the newest frame when the window expires", async () => { /* ... */ });

  it("wakes up at expiry even with no further events", async () => { /* ... */ });

  it("does not shorten an existing cooldown with a smaller retry_after", async () => { /* ... */ });

  it("shares the cooldown across sessions on the same apiUrl, trailing slash included", async () => { /* ... */ });

  it("lets a finalize frame through inside the window", async () => { /* ... */ });

  it("still retries a network failure and a 5xx", async () => { /* ... */ });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/card-progress.test.ts`
Expected: FAIL —— 429 仍本地重试、无冷却门；补了 `headers` 的两处旧用例调用计数也变了

- [ ] **Step 3: 实现**

`isRetryableRegistryEditError`（`:416`）去掉 429：

```ts
  // 429 is owned by the single backoff in postJson, and progress frames opt out of it
  // entirely: retrying here at 100/250ms ignored the server's stated wait and, once
  // postJson also retried, multiplied into nine requests for one frame.
  return transportStatus === undefined || transportStatus >= 500 ||
    (semanticStatus !== undefined && semanticStatus >= 500) || errorCode === "err.shared.internal";
```

模块内加冷却门：

```ts
/**
 * Earliest time each backend will accept another progress frame, keyed by API URL.
 *
 * Keyed per URL rather than per card because the server's bucket is per source IP:
 * every session and every bot pointed at one backend shares it, so timing them
 * separately would just have each of them rediscover the same limit.
 */
const rateLimitedUntil = new Map<string, number>();

const cooldownKey = (apiUrl: string): string => apiUrl.replace(/\/+$/, "");

function noteRateLimited(apiUrl: string, retryAfterMs: number): void {
  const key = cooldownKey(apiUrl);
  const until = Date.now() + retryAfterMs;
  // Monotonic: a concurrent 429 carrying a smaller wait must not shorten a cooldown
  // that is already in place, or we would go back early after all.
  rateLimitedUntil.set(key, Math.max(rateLimitedUntil.get(key) ?? 0, until));
}

function cooldownRemainingMs(apiUrl: string): number {
  return Math.max(0, (rateLimitedUntil.get(cooldownKey(apiUrl)) ?? 0) - Date.now());
}
```

`runFlush` 在 transient 发送前检查，并在到期时唤醒：

```ts
    const cooldown = cooldownRemainingMs(entry.ctx.apiUrl);
    if (cooldown > 0) {
      // Keep dirty so the newest state still goes out, and arm a single wake-up: a
      // bare return would never come back without another event, while leaning on the
      // debounce would spin every 800ms for the whole window.
      if (!entry.cooldownTimer) {
        entry.cooldownTimer = setTimeout(() => {
          entry.cooldownTimer = undefined;
          // Re-read: the window may have been extended after this timer was armed,
          // in which case waking now would send early.
          if (cooldownRemainingMs(entry.ctx.apiUrl) > 0) { /* re-arm below */ }
          if (!isCurrentEntry(sessionKey, entry)) return; // stale entry, stay out
          if (entry.dirty) void flush(sessionKey);
        }, cooldown);
      }
      return;
    }
```

`CardEntry` 加 `cooldownTimer?: ReturnType<typeof setTimeout>`，并在 `runFlush` 的 `finally`（`:649` 旁）与 entry 被替换 / finalize / clear 的地方 `clearTimeout` 它。

429 捕获处（`:639` 的 catch）加 `if (err instanceof OctoApiError && err.isRateLimited) noteRateLimited(entry.ctx.apiUrl, err.retryAfterMs);`。

transient 发送与占位首帧的 `postJson` 传 `{ retryOn429: false }` —— 通过 `editEntryProgress` / send 调用链把 `retryOn429` 透传到 `api-fetch` 的对应函数。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/card-progress.test.ts && npm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/card-progress.ts src/card-progress.test.ts
git commit -m "fix(cards): stop progress frames from probing inside the server's cooldown"
```

---

### Task 9: 改写记录旧契约的测试 + 全量回归

**Files:**
- Modify: `src/reconnect-fixes.test.ts:288-334`、`:383-406`、`:410-432`

**Interfaces:**
- Consumes: 前八个任务的全部改动。
- Produces: 无。

- [ ] **Step 1: 改写三组过期用例**

这三组都用局部变量自证、**不会自动 fail**，但明文记录了已被废弃的契约，留着会误导后来的人：

- `:288-334`「断开清心跳」/「连接重启心跳」→ 改写为"心跳生命周期跟随账号，断开与重连都不触碰它"。
- `:383-406`「心跳失败后延迟重连」+ 抖动 → 该契约整体消失（心跳不再触发重连），删掉，抖动的断言移到监督者那侧。
- `:410-432`「连接成功重置心跳失败计数」→ 改写为"计数只统计非 429，且不驱动任何重连"。

- [ ] **Step 2: 全量回归**

Run: `npm run type-check && npm test`
Expected: 全绿。任何红都不许用 skip 掩过去 —— 回到对应任务修。

- [ ] **Step 3: 打包校验**

Run: `npm run pack:check`
Expected: `dist/index.js` 与 `dist/setup-entry.js` 都在 tarball 里

- [ ] **Step 4: Commit**

```bash
git add src/reconnect-fixes.test.ts
git commit -m "test(socket): retire the assertions that pinned the beat to the connection"
```

---

## Self-Review

**Spec coverage** —— spec 的每节都能指到任务：§1→T1、§2→T2+T3、§3→T8、§4→T4+T7、§5→T6+T7、§6 三个前置修复→T5(两个)+T7(第三个)、§7 数据流→贯穿、测试策略→各任务的测试步骤 + T9、兼容性三条行为变化→T2(deadline)、T8(丢帧)、T9(旧契约)。

**Placeholder scan** —— Task 5/7/8 的部分测试用例只给了意图与断言目标、没给完整代码（涉及假 `WebSocket` 与 card-progress 既有 harness 的搭建，需就地参照同文件已有写法）。**这是本计划已知的粗糙处**：执行到那三个任务时先读同文件邻近用例的搭建方式，再把用例补全，不要照着注释硬猜。其余步骤均为可直接执行的实码。

**Type consistency** —— `OctoApiError.from(resp, path, body)` 三参在 T1 定义、T2 与 T8 按此调用；`isConnectingOrConnected()` / `hasPendingReconnect()` 在 T5 定义、T7 使用；`createHeartbeatLoop` 的 `send: (signal) => Promise<void>` 与 T3 改造后的 `sendHeartbeat({..., signal})` 对齐；`createConnectionWatchdog` 的 `reconnect` 返回 `void | Promise<void>`，T7 传的是返回 `Promise<void>` 的 `runReconnectSequence`，兼容。
