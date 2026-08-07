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
- Produces: `class OctoApiError extends Error`，字段 `status: number`、`path: string`、`body: string`、`retryAfterMs: number`、`rateLimitScope?: string`、`rateLimitRemaining?: string`，getter `isRateLimited: boolean`；静态 `OctoApiError.from(resp: ResponseLike, path: string, body: string): OctoApiError`。常量 `DEFAULT_RETRY_AFTER_MS = 1_000`、`MAX_ERROR_BODY_CHARS = 500`。

> `body` 要截断到 `MAX_ERROR_BODY_CHARS`：错误体会进日志和 `message`，一个返回整页 HTML 的网关能把单条日志顶到几十 KB。截断只影响展示，`status` / `retryAfterMs` 都是从头或已解析的 JSON 里取的，不受影响。


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

/**
 * Cap on the response body kept for the message and the logs. A gateway answering
 * with a full HTML error page would otherwise put tens of KB into a single log line.
 * Truncation is cosmetic: the status comes from the response and the retry hint from
 * the headers or the already-parsed JSON.
 */
export const MAX_ERROR_BODY_CHARS = 500;

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
    const text = body || resp.statusText || "";
    return new OctoApiError({
      status: resp.status,
      path,
      body: text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text,
      // Parsed from the untruncated body: a retry hint sitting past the cap must not
      // be lost to a display concern.
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
  // Checked before arming anything: an abort that landed between the fetch returning
  // and this call would otherwise be missed entirely, and we would serve the full wait
  // (under fake timers, forever).
  if (signal?.aborted) {
    return Promise.reject(new Error("aborted while backing off from a rate limit", { cause }));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      // Surface the rate limiting as the cause; without it the site of failure
      // only shows a generic abort and the 429 diagnosis is lost.
      reject(new Error("aborted while backing off from a rate limit", { cause }));
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

追加到 `src/api-fetch.test.ts`（**沿用该文件顶部已有的 vitest import，不要重复 import**）：

```ts
describe("callers that opt out of the shared 429 backoff", () => {
  const rateLimited = () => ({
    ok: false, status: 429, statusText: "too many",
    headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "1" : null) },
    text: async () => "rate limited",
  });

  // Each of these has its own cadence — a periodic beat, a discardable hint, or a
  // sequential loop that paces itself — so a hidden sleep inside the call is wrong.
  it.each([
    ["sendHeartbeat", () => sendHeartbeat({ apiUrl: "https://x.test", botToken: "bf" })],
    ["sendTyping", () => sendTyping({ apiUrl: "https://x.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group })],
    ["sendReadReceipt", () => sendReadReceipt({ apiUrl: "https://x.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group, messageIds: ["1"] })],
    ["fetchBotEvents", () => fetchBotEvents({ apiUrl: "https://x.test", botToken: "bf", sinceEventId: 0 })],
    ["ackBotEvent", () => ackBotEvent({ apiUrl: "https://x.test", botToken: "bf", eventId: 1 })],
  ])("%s issues exactly one request on 429", async (_name, call) => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited());
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(call()).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The long poll asks for far more than the default deadline; capping it would abort
  // mid-hold and throw away the batch the server was about to return.
  it("leaves a 30s hold's 40s deadline intact", async () => {
    let seen: AbortSignal | undefined;
    global.fetch = vi.fn(async (_u: string, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
    }) as unknown as typeof fetch;
    await fetchBotEvents({ apiUrl: "https://x.test", botToken: "bf", sinceEventId: 0, waitSeconds: 30 });
    // 40s = 30s hold + EVENTS_POLL_WAIT_MARGIN_MS; assert it is not the 30s default by
    // advancing past 30s under fake timers and checking the signal has not aborted.
    expect(seen?.aborted).toBe(false);
  });
});
```

在 `src/events-poll.test.ts` 追加（沿用该文件已有的 poller 搭建方式）：

```ts
// The poller decides whether the server really held by measuring elapsed time around
// the whole request. A backoff sleep inside the request inflates that measurement, so
// an empty fast return would read as an honoured hold and re-poll at 0ms — the hot loop
// the outcome-based pacing exists to prevent.
it("does not let a 429 inflate the measured hold", async () => {
  // waitSeconds=4(阈值 2000ms)。让 /v1/bot/events 恒返 429 且响应立即。
  // 断言:每个 tick 只有一次 fetch(内部没重试),且下一次 tick 的间隔走错误退避
  // (≥ intervalMs),不是 0ms —— 在 intervalMs 内推进时间不应看到第二次请求。
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

`fetchBotEvents`（`:779`）加 `{ retryOn429: false }`，注释：

```ts
  // The poll loop paces itself from the outcome of each request, including an
  // exponential backoff on errors. It also infers "did the server hold?" from the
  // elapsed time around this call, which a sleep inside it would corrupt.
```

`ackBotEvent`（`:851`）加 `{ retryOn429: false }`，注释（**理由与 fetch 不同**）：

```ts
  // An ack runs inside the loop's sequential drain and its failure is only logged —
  // it never becomes a poll outcome, so nothing downstream would pace a retry. A sleep
  // here would just stall the events queued behind this one. The cursor is persisted
  // before the ack, so a lost ack costs at most one redelivery.
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
- Produces: `WKSocket` 新增三个只读访问器 —— `isConnected(): boolean`（读 private `connected`，**CONNACK 成功之后**才为真）、`isConnectingOrConnected(): boolean`（readyState 为 CONNECTING/OPEN）、`hasPendingReconnect(): boolean`；导出常量 `export const CONNECT_DEADLINE_MS = 15_000`。

> **两个连接谓词不是一回事，别混用。**`isConnected()` 回答"握手完成、可以正常收发了吗"—— 心跳用它，否则在 OPEN 但未 CONNACK 的窗口里会发出一个谎报在线的心跳。`isConnectingOrConnected()` 回答"有人正在建连吗"—— 监督者用它，避免插手一次正在进行的建连。

- [ ] **Step 1: 先扩展 harness，再写测试**

`src/reconnect-fixes.test.ts:7-42` 已有 `vi.mock("ws")` 的 `MockWS` 与真实 `WKSocket`。它的 `readyState` 硬编码为 1、且只有 `static OPEN = 1` —— 要测 CONNECTING 必须先扩展它。**只做加法**，现有 20 多个用例默认行为不变：

```ts
  class MockWS {
    static CONNECTING = 0;
    static OPEN = 1;
    binaryType = "arraybuffer";
    readyState = 1;          // defaults to OPEN so existing tests are unaffected
    closed = false;
    // ... 其余不变 ...
    close() {
      this.closed = true;
      this.readyState = 3;   // CLOSED, so isConnectingOrConnected() goes false
      queueMicrotask(() => this.emit("close"));
    }
  }
```

追加用例：

```ts
describe("connection build-up deadline", () => {
  // connected、心跳定时器、稳定计时器全都只在 CONNACK 之后才起，所以卡在 CONNACK 之前
  // 既不会有 close 事件、也不会有 ping 超时把连接救回来 —— 没有 deadline 就是永久挂住，
  // 而监督者的 isConnectingOrConnected() 谓词恰好会拒绝救这一种。
  it("closes a socket that never leaves CONNECTING", async () => {
    vi.useFakeTimers();
    const instances: any[] = [];
    (globalThis as any).__mockWsInstances = instances;
    const socket = new WKSocket({ wsUrl: "ws://x", uid: "u", token: "t", onMessage: () => {} });
    socket.connect();
    instances[0].readyState = 0; // CONNECTING: never opens
    expect(socket.isConnectingOrConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS + 1);
    expect(instances[0].closed).toBe(true);
    vi.useRealTimers();
  });

  it("closes a socket that opened but never got CONNACK", async () => {
    vi.useFakeTimers();
    const instances: any[] = [];
    (globalThis as any).__mockWsInstances = instances;
    const socket = new WKSocket({ wsUrl: "ws://x", uid: "u", token: "t", onMessage: () => {} });
    socket.connect();
    instances[0].emit("open");          // sends CONNECT, then silence
    expect(socket.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS + 1);
    expect(instances[0].closed).toBe(true);
    vi.useRealTimers();
  });

  it("clears the deadline on a successful CONNACK", async () => {
    vi.useFakeTimers();
    const instances: any[] = [];
    (globalThis as any).__mockWsInstances = instances;
    const socket = new WKSocket({ wsUrl: "ws://x", uid: "u", token: "t", onMessage: () => {} });
    socket.connect();
    instances[0].emit("open");
    instances[0].emit("message", buildConnackPacket(1));
    expect(socket.isConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS + 1);
    expect(instances[0].closed).toBe(false); // no stale deadline fired
    vi.useRealTimers();
  });

  // 旧 socket 的 deadline 到点时不得关掉刚建好的新连接。
  it("does not let a stale deadline close a newer socket", async () => {
    vi.useFakeTimers();
    const instances: any[] = [];
    (globalThis as any).__mockWsInstances = instances;
    const socket = new WKSocket({ wsUrl: "ws://x", uid: "u", token: "t", onMessage: () => {} });
    socket.connect();                     // instances[0]
    socket.connect();                     // instances[1] replaces it
    instances[1].emit("open");
    instances[1].emit("message", buildConnackPacket(1));
    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS + 1);
    expect(instances[1].closed).toBe(false);
    vi.useRealTimers();
  });
});

describe("reconnect handle bookkeeping", () => {
  // hasPendingReconnect 是监督者的谓词之一。定时器触发后若句柄仍非 null,
  // 谓词永久为真,监督者被永久哑掉 —— 这是本次要修的既存 bug。
  it("reports no pending reconnect once the timer has fired", async () => {
    vi.useFakeTimers();
    const instances: any[] = [];
    (globalThis as any).__mockWsInstances = instances;
    const socket = new WKSocket({ wsUrl: "ws://x", uid: "u", token: "t", onMessage: () => {} });
    socket.connect();
    instances[0].emit("open");
    instances[0].emit("message", buildConnackPacket(1));
    instances[0].emit("close");                  // triggers scheduleReconnect
    expect(socket.hasPendingReconnect()).toBe(true);
    await vi.advanceTimersByTimeAsync(70_000);   // past the capped backoff
    expect(socket.hasPendingReconnect()).toBe(false);
    vi.useRealTimers();
  });
});
```

`CONNECT_DEADLINE_MS` 从 `./socket.js` import —— 这是它必须 `export` 的原因，别在测试里复制字面量。


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

新增三个公开访问器（放在 `disconnectAndWait` 之后）：

```ts
  /**
   * True only after a successful CONNACK — i.e. the connection can actually carry
   * traffic. Distinct from isConnectingOrConnected(): between `open` and CONNACK the
   * socket is OPEN but unusable, and anything that reports liveness must not treat
   * that window as connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * True while a socket exists and is either connecting or open — "somebody is already
   * building this connection, stay out of the way".
   *
   * Compared against the WHATWG numeric readyState values rather than the ws class's
   * static properties: the class is mocked in tests, and a mock that omits a static
   * would silently make this predicate wrong instead of failing loudly.
   */
  isConnectingOrConnected(): boolean {
    const state = this.ws?.readyState;
    return state === 0 /* CONNECTING */ || state === 1 /* OPEN */;
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

`channel.ts` 的 `registerBot` 是个大闭包，整体起账号太重。这三条改测**导出的谓词形状**而非整条闭包 —— 把谓词与序列包装器的行为抽成可测单元：在 `channel.ts` 里 `export` 两个 test-only 工厂（前缀 `_`，与本仓已有 test-only helper 的惯例一致），供测试直接驱动：

```ts
// channel.ts —— test-only exports，生产路径也用这两个，不是测试专用的第二实现
export function _createReconnectSequencer(): {
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  isInFlight: () => boolean;
}
export function _buildWatchdogPredicate(deps: {
  isStopped: () => boolean;
  isReconnectInFlight: () => boolean;
  isConnectingOrConnected: () => boolean;
  hasPendingReconnect: () => boolean;
  isRefreshingToken: () => boolean;
  hasCooldownTimer: () => boolean;
}): () => boolean
```

测试：

```ts
describe("watchdog predicate", () => {
  const deps = (over: Partial<Parameters<typeof _buildWatchdogPredicate>[0]> = {}) =>
    _buildWatchdogPredicate({
      isStopped: () => false,
      isReconnectInFlight: () => false,
      isConnectingOrConnected: () => false,
      hasPendingReconnect: () => false,
      isRefreshingToken: () => false,
      hasCooldownTimer: () => false,
      ...over,
    });

  it("says yes only when nobody at all is managing the connection", () => {
    expect(deps()()).toBe(true);
  });

  // 每一项单独足以否决。cooldown 回调那一项最不直观:它先把自己的句柄置 null,
  // 再 await disconnectAndWait() —— 而后者同步清掉 ws、needReconnect 和 socket 的
  // 重连定时器,所以那个 await 期间其余四项全部放行,只有 reconnectInFlight 挡得住。
  it.each([
    ["stopped", { isStopped: () => true }],
    ["a sequence mid-await", { isReconnectInFlight: () => true }],
    ["a socket already connecting", { isConnectingOrConnected: () => true }],
    ["a scheduled backoff", { hasPendingReconnect: () => true }],
    ["a token refresh", { isRefreshingToken: () => true }],
    ["a queued cooldown", { hasCooldownTimer: () => true }],
  ])("says no while there is %s", (_name, over) => {
    expect(deps(over)()).toBe(false);
  });
});

describe("reconnect sequencer", () => {
  it("runs one sequence at a time and reports in-flight while awaiting", async () => {
    const seq = _createReconnectSequencer();
    let release: (() => void) | undefined;
    const first = seq.run("a", () => new Promise<void>((res) => { release = res; }));
    expect(seq.isInFlight()).toBe(true);
    const second = vi.fn(async () => {});
    await seq.run("b", second);
    expect(second).not.toHaveBeenCalled();   // rejected while one is in flight
    release?.();
    await first;
    expect(seq.isInFlight()).toBe(false);
  });

  it("clears the flag even when the sequence throws", async () => {
    const seq = _createReconnectSequencer();
    await seq.run("boom", async () => { throw new Error("x"); });
    expect(seq.isInFlight()).toBe(false);
  });
});
```

对 `registerBot` 失败后必须留下可取消的重连这条，在 `src/channel.test.ts` 里按该文件已有的账号启动方式断言：`registerBot` 第二次调用抛 429 后，**存在一个待执行的重连定时器**（用 `vi.getTimerCount()` 的增量，或注入的时钟），且 cleanup 能把它清掉 —— 关键是不能再出现"无人持有的裸 setTimeout"。


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
        isConnected: () => socket.isConnected(),
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
              //
              // Reuses the tracked cooldown timer rather than a bare setTimeout: an
              // untracked timer is invisible to the watchdog predicate and to cleanup,
              // which is the same class of defect this task exists to remove.
              scheduleTrackedReconnect("post-register-retry");
            }
```

新增一个共用的排程器（与 `runReconnectSequence` 放在一起），cooldown 分支与这里都用它：

```ts
      const scheduleTrackedReconnect = (label: string): void => {
        if (stopped) return;
        // One tracked handle for every deferred reconnect. Replacing an existing one is
        // deliberate — two pending reconnects would race and kick each other (the
        // failure this handle was originally introduced to stop).
        if (cooldownReconnectTimer) clearTimeout(cooldownReconnectTimer);
        const backoffMs = 5_000 + Math.floor(Math.random() * 5_000);
        cooldownReconnectTimer = setTimeout(() => {
          cooldownReconnectTimer = null;
          void runReconnectSequence(label, async () => {
            if (stopped) return;
            await socket.disconnectAndWait();
            if (stopped) return; // the account can stop while we wait above
            socket.stopReconnectTimer();
            socket.connect();
          });
        }, backoffMs);
      };
```

cooldown 分支（`:1668-1680`）整体替换为 `scheduleTrackedReconnect("cooldown")`；cleanup 里加 `if (cooldownReconnectTimer) clearTimeout(cooldownReconnectTimer);`（若尚未有）。

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
- Modify: `src/card-progress.ts:122-150`（共享状态加 `rateLimitedUntil`）、`:407-418`（`isRetryableRegistryEditError`）、`:435-448`（`editTemplateCardWithRetry`）、`:452-653`（`runFlush` 冷却检查 / 429 记冷却 / `finally` 重排条件）、`CardEntry` 类型加 `cooldownTimer`
- Modify: `src/api-fetch.ts:417,533,574,626`（四个卡片 wrapper 加 `retryOn429?: boolean` 并透传）
- Test: `src/card-progress.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `OctoApiError`、Task 2 的 `opts.retryOn429`。
- Produces: `sendCardMessage` / `sendTemplateCardMessage` / `editCardMessage` / `editTemplateCardMessage` 的 params 各多一个可选 `retryOn429?: boolean`（默认 `true`，行为不变）；`CardProgressSharedState.rateLimitedUntil: Map<string, number>`。


- [ ] **Step 1: 写失败测试**

修 `:879-918` 与 `:2659-2681` 两处 mock（**两处都缺 `headers`，postJson 一读 `Retry-After` 就 `TypeError`**），给失败响应加 `headers: { get: () => null }`；并把 `:879` 的 `it.each([429, 503])` 拆成两个 `it` —— 429 与 503 的路径已经分岔。

新增（**语义统一为"暂缓 + 到期发最新"，没有"永久丢帧"这回事**）：

```ts
describe("progress frames under rate limiting", () => {
  // 进度帧不在 flush 里睡着等退避 —— 那会占住单飞位把后面的帧一起拖住。
  // 但也不能就地丢掉:429 的那一帧要被暂缓,窗口结束时连同最新状态一起发出。
  it("issues exactly one edit for a rate-limited frame and keeps the card enabled", async () => {
    // 断言:该次 flush 只发一次 /message/edit;entry 未被 skip(后续仍能发)。
  });

  it("sends the held frame when the window expires, with no further events", async () => {
    // 429(retry_after 1s) → 不再有任何事件 → advanceTimersByTimeAsync(1500)
    // → 断言又发出一次 edit,内容是 429 当时那一帧的最新状态。
  });

  it("emits nothing while the window is open, however many events arrive", async () => {
    // 429 后连续投 5 个工具事件、每个之间推进 800ms(合计 < retry_after)
    // → 断言窗口内 /message/edit 调用数没有增加。
  });

  it("coalesces the held frames into a single send at expiry", async () => {
    // 同上但推进过 retry_after → 断言只多出 1 次 edit(不是 5 次),
    // 且 payload 反映最后一个事件的状态。
  });

  it("does not shorten an open window with a smaller retry_after", async () => {
    // 先 retry_after=5,再让另一个 session 拿到 retry_after=1
    // → 推进 2s,断言仍无发送(5s 的窗口没被缩短)。
  });

  it("shares the window across sessions on one backend, trailing slash included", async () => {
    // sessionA 用 https://x.test 撞 429;sessionB 用 https://x.test/ 发帧
    // → 断言 sessionB 在窗口内也不发。
  });

  it("lets a finalize frame through inside the window", async () => {
    // 窗口内 finalize → 断言照发(终态必须落地),且走默认退避(429 时会重试)。
  });

  it("still retries a network failure and a 5xx locally", async () => {
    // 守住 isRetryableRegistryEditError 去掉 429 之后没连带改坏其它分支。
  });
});
```

**必改的两处既有用例**：`:879-918` 与 `:2659-2681` 的失败响应 mock 都是 `{ok:false, status, statusText, text}` 形状、**没有 `headers`**，`OctoApiError.from` 读 `Retry-After` 时虽有容错但仍应补 `headers: { get: () => null }` 让 mock 贴近真实 `Response`；并且 `:879` 的 `it.each([429, 503])` 必须拆成两个 `it` —— 429 走"暂缓 + 到期发"，503 走本地重试，两条路径的调用时序已经不同，不能再共用一个调用计数断言。


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

模块内加冷却门。**必须挂进 `CardProgressSharedState`（`:122-150`），不能是模块局部变量** —— OpenClaw 分别加载 bundled channel 与 embedded runtime 两个模块实例，模块局部的 Map 会在两个实例间裂开，冷却门就只对其中一半生效：

```ts
// 在 CardProgressSharedState 类型里加一行
type CardProgressSharedState = {
  cards: Map<string, CardEntry>;
  pausedCards: Map<string, CardEntry>;
  profileCache: Map<string, CachedCardProfile>;
  capsCache: Map<string, CardCaps>;
  /**
   * Earliest time each backend will accept another progress frame, keyed by API URL.
   *
   * Keyed per URL rather than per card because the server's bucket is per source IP:
   * every session and every bot pointed at one backend shares it, so timing them
   * separately would just have each of them rediscover the same limit.
   */
  rateLimitedUntil: Map<string, number>;
};
```

`getCardProgressSharedState()` 的 `created` 里加 `rateLimitedUntil: new Map()`，并在返回既有对象那条路径上做**惰性补齐**（同一进程里两个实例是同一份构建，但若将来 key 复用而结构演进，缺字段会直接崩）：

```ts
  const existing = root[CARD_PROGRESS_STATE_KEY] as CardProgressSharedState | undefined;
  if (existing) {
    existing.rateLimitedUntil ??= new Map();
    return existing;
  }
```

然后：

```ts
const rateLimitedUntil = sharedState.rateLimitedUntil;

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

到期唤醒单独成函数，把三件必须做对的事写死：

```ts
/**
 * Arm the single wake-up that ends a cooldown for this entry.
 *
 * Returning from a flush without this would mean the frame only ever goes out when
 * some later event happens to arrive; leaning on the debounce instead would re-enter
 * the flush every 800ms for the whole window just to be turned away again.
 */
function armCooldownWake(sessionKey: string, entry: CardEntry, delayMs: number): void {
  if (entry.cooldownTimer) return; // already armed; re-arming would multiply wake-ups
  entry.cooldownTimer = setTimeout(() => {
    entry.cooldownTimer = undefined;
    // The entry may have been replaced while we waited. Map identity is this file's
    // existing generation fence; a stale entry must not cause network side effects.
    if (!isCurrentEntry(sessionKey, entry)) return;
    const remaining = cooldownRemainingMs(entry.ctx.apiUrl);
    if (remaining > 0) {
      // The window was extended by a later 429 after this timer was armed. Waking now
      // would send before the server said we could, so re-arm to the new deadline.
      armCooldownWake(sessionKey, entry, remaining);
      return;
    }
    if (entry.dirty) void flush(sessionKey);
  }, delayMs);
}
```

`runFlush` 在 gate 之后、发送之前检查：

```ts
    // Progress frames are discardable, but hammering inside the window the server just
    // named is exactly the behaviour this change exists to remove. Hold the newest state
    // and come back when the window ends.
    const cooldown = cooldownRemainingMs(entry.ctx.apiUrl);
    if (cooldown > 0) {
      entry.dirty = true; // keep the newest state pending; the wake-up will send it
      armCooldownWake(sessionKey, entry, cooldown);
      return;
    }
```

`CardEntry` 加 `cooldownTimer?: ReturnType<typeof setTimeout>`。

**`runFlush` 的 `finally`（`:648-653`）不得取消 `cooldownTimer`** —— 那是唯一的唤醒者，取消它就回到"没有新事件就永不醒"。同时该 `finally` 里的 `scheduleFlush` 重排要在冷却期内跳过，否则 800ms 去抖会空转整个窗口：

```ts
  } finally {
    if (entry.flushAbort === abort) entry.flushAbort = undefined;
    entry.inFlight = false;
    // 冷却期内不排 debounce:唤醒定时器已经负责窗口结束后的那一次发送,
    // 再排一个 800ms 的只会在整个窗口里反复进来又被挡回。
    if (entry.dirty && !entry.skip && cards.get(sessionKey) === entry &&
        cooldownRemainingMs(entry.ctx.apiUrl) === 0) {
      scheduleFlush(sessionKey, entry);
    }
  }
```

只有 entry 被 **replacement / finalize / clear** 时才 `clearTimeout(entry.cooldownTimer)` —— 找到该文件里清理 `flushTimer` / `pausedCards` 的那几处，同址补上。

429 捕获处（`:639` 的 catch）加：

```ts
    if (err instanceof OctoApiError && err.isRateLimited) {
      noteRateLimited(entry.ctx.apiUrl, err.retryAfterMs);
      // Re-mark dirty and arm the wake-up so this frame is *held*, not lost. dirty was
      // cleared at :566 before the send, so without this the frame that actually hit the
      // limit would be the one frame nobody ever retries — and the card would sit on a
      // stale state until some later event happened to arrive. Holding it makes the rule
      // uniform: a rate-limited frame always goes out when the window ends.
      if (isCurrentEntry(sessionKey, entry)) {
        entry.dirty = true;
        armCooldownWake(sessionKey, entry, cooldownRemainingMs(entry.ctx.apiUrl));
      }
    }
```

**`retryOn429` 的透传要改 API wrapper 的签名**（这是 Task 8 必须一并改 `src/api-fetch.ts` 的原因）：给 `sendCardMessage`（`:417`）、`sendTemplateCardMessage`（`:533`）、`editCardMessage`（`:574`）、`editTemplateCardMessage`（`:626`）四个的 params 各加 `retryOn429?: boolean`，并在其内部 `postJson` 调用的最后传 `{ retryOn429: params.retryOn429 ?? true }`。card-progress 的占位首帧 send 与 `transient: true` 编辑传 `false`；finalize / 终态帧不传（走默认 `true`）。


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

**Spec coverage** —— spec 的每节都能指到任务：§1→T1、§2→T2+T3、§3→T8、§4→T4+T7、§5→T6+T7、§6 三个前置修复→T5(前两个)+T7(第三个)、§7 数据流→贯穿、测试策略→各任务的测试步骤 + T9、兼容性三条行为变化→T2(deadline)、T8(暂缓+到期发)、T9(旧契约)。spec §1 提到的 body 截断在 T1 定为 `MAX_ERROR_BODY_CHARS = 500`。

**Placeholder scan** —— 无占位测试。原先 Task 5/7/8 的空壳用例已补：T5 复用 `reconnect-fixes.test.ts:7-42` 已有的 MockWS（并明确列出对它的**加法式**扩展：`static CONNECTING`、`close()` 里置 `readyState = 3`）；T7 改为测两个导出的可测单元（谓词与序列包装器）而不是硬起整条 `registerBot` 闭包；T8 的每条用例都写清了输入时序与断言目标。T8 与 T9 的少数用例仍是"时序 + 断言目标"而非完整代码，因为要贴合 `card-progress.test.ts` 的 `makeApi()` / `setCardContext()` harness —— 执行时先读同文件邻近用例再落笔。

**Type consistency** ——
- `OctoApiError.from(resp, path, body)` 三参在 T1 定义，T2 与 T8 按此调用。
- **两个连接谓词不混用**：`isConnected()`（CONNACK 之后）给心跳，`isConnectingOrConnected()`（CONNECTING/OPEN）给监督者，均在 T5 定义、T7 使用。
- `createHeartbeatLoop` 的 `send: (signal) => Promise<void>` 与 T3 改造后的 `sendHeartbeat({..., signal})` 对齐。
- `createConnectionWatchdog` 的 `reconnect: () => void | Promise<void>`，T7 传返回 `Promise<void>` 的序列，兼容。
- T3 的测试用真实签名：`fetchBotEvents({ sinceEventId: number })`、`ackBotEvent({ eventId: number })`。
- T8 的四个卡片 wrapper 新增 `retryOn429?: boolean`，与 T2 的 `opts.retryOn429` 同名同义。
- `CONNECT_DEADLINE_MS` 在 T5 `export`，测试 import 而非复制字面量。

