import { afterEach, describe, expect, it, vi } from "vitest";
import { postDocComment } from "./api-fetch.js";

/**
 * `postDocComment` 是整个文档任务特性**唯一**的投递凭证 —— handler 靠它成没成来
 * 决定要不要写持久去重。所以它有两条不能松的约束:
 *
 *   1. **必须有界。** 多处调用点不传 signal(handler 的兜底通知、会话冲突回执、
 *      deliver() 的正常答复),而这条 POST 是在轮询器的单条循环里 await 的。docs
 *      后端接了连接却不回包,handleDocMention 就永不返回,该账号的文档任务和卡片
 *      事件一起停到重启为止 —— 而 hang 不是 try/catch 能接住的,轮询器那层兜底
 *      对它无效。
 *   2. **HTTP 2xx 不等于投递成功。** 平台返回 `{status, ...}` 信封,业务失败
 *      (文档不存在、无评论权限、正文超长)一样可能是 200。只看 response.ok 会把
 *      业务失败记成「已投递」,进而写入去重、永不重投。
 */

const API = "http://octo.test";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** 捕获传给 fetch 的 init,用于检查 signal。 */
function captureFetch(body: unknown, status = 200): { inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  globalThis.fetch = vi.fn(async (_input: any, init?: RequestInit) => {
    inits.push(init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { inits };
}

describe("postDocComment", () => {
  it("调用方不传 signal 时也必须带一个有界 signal(否则挂起会楔死轮询器)", async () => {
    const { inits } = captureFetch({ status: 1 });

    await postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "已改好" });

    expect(inits).toHaveLength(1);
    const signal = inits[0].signal;
    expect(signal, "postDocComment 必须给 fetch 一个默认超时 signal").toBeInstanceOf(AbortSignal);
  });

  it("调用方传了 signal 就用调用方的", async () => {
    const { inits } = captureFetch({ status: 1 });
    const controller = new AbortController();

    await postDocComment({
      apiUrl: API,
      botToken: "tok",
      docId: "d1",
      body: "已改好",
      signal: controller.signal,
    });

    expect(inits[0].signal).toBe(controller.signal);
  });

  it("挂起的 docs 后端不会让调用永远不返回", async () => {
    // 用调用方的短 signal 验证「signal 确实接到了 fetch 上」这条链路是通的;
    // 默认路径同样接上(上面第一条),只是默认超时是 30s,不适合在测试里等。
    globalThis.fetch = vi.fn(
      (_input: any, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;

    await expect(
      postDocComment({
        apiUrl: API,
        botToken: "tok",
        docId: "d1",
        body: "已改好",
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toThrow();
  });

  it("HTTP 200 但信封 status != 1:必须抛错 —— 业务失败不能算已投递", async () => {
    captureFetch({ status: 400, msg: "document not found" });

    await expect(
      postDocComment({ apiUrl: API, botToken: "tok", docId: "missing", body: "已改好" }),
    ).rejects.toThrow(/rejected the comment/);
  });

  it("信封 status = 1:正常返回", async () => {
    captureFetch({ status: 1, data: { id: 9 } });

    await expect(
      postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "已改好" }),
    ).resolves.toBeUndefined();
  });

  it("响应没有 status 字段(空 body 或非信封形状):不误判为失败", async () => {
    // docs 后端未必用同一套信封,缺字段时按 HTTP 语义处理即可,不能一律当失败 ——
    // 否则每条评论都会被判丢失,任务永远无法完成。
    captureFetch({ id: 9 });

    await expect(
      postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "已改好" }),
    ).resolves.toBeUndefined();
  });
});
