import { afterEach, describe, expect, it, vi } from "vitest";
import { DocCommentRejectedError, isPermanentDocCommentFailure, postDocComment } from "./api-fetch.js";

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
  it("超过 2^53 的 parentId 必须在**线上字节**里一位不差(否则答复挂到另一条真实评论下)", async () => {
    // 这条锁看的是真正发出去的 request body 文本,不是中间变量。
    // 前几轮的教训:只断言函数返回值,序列化那一步(JSON.stringify)照样能悄悄改值。
    const snowflake = "738523091827364987";
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_input: any, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ status: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await postDocComment({
      apiUrl: API,
      botToken: "tok",
      docId: "d1",
      body: "已改好",
      parentId: snowflake,
    });

    expect(bodies).toHaveLength(1);
    // 必须是**不带引号的数字字面量**:带引号是字符串类型,后端按数字读会拒。
    expect(bodies[0]).toContain(`"parentId":${snowflake}`);
    expect(bodies[0]).not.toContain(`"parentId":"${snowflake}"`);
    // 反证:走 number 会落到 738523091827364900,即另一条评论。
    expect(bodies[0]).not.toContain(String(Number(snowflake)));
  });

  it("安全整数范围内的 parentId 照样是数字字面量,行为不变", async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_input: any, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ status: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "b", parentId: "70" });

    expect(bodies[0]).toContain('"parentId":70');
  });

  it("无法无损表示的 parentId 省略该字段发根评论,而不是退回一个已变值的数字", async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_input: any, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ status: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "b", parentId: "c_abc" });

    expect(bodies[0]).not.toContain("parentId");
    expect(bodies[0]).toContain('"body":"b"');
  });

  it("调用方不传 signal 时也必须带一个有界 signal(否则挂起会楔死轮询器)", async () => {
    const { inits } = captureFetch({ status: 1 });

    await postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "已改好" });

    expect(inits).toHaveLength(1);
    const signal = inits[0].signal;
    expect(signal, "postDocComment 必须给 fetch 一个默认超时 signal").toBeInstanceOf(AbortSignal);
  });

  it("调用方传了 signal 时,该 signal 的 abort 仍然能中断请求", async () => {
    // 不断言与调用方 signal 对象相等:main 给 POST 加了绝对上限
    // (api-fetch.ts POST_HARD_CEILING_MS),调用方传 signal 时会被包成
    // AbortSignal.any([调用方, timeout(上限)]),所以引用不再相同。
    // 真正该钉住的是行为 —— 调用方一 abort,落到 fetch 上的 signal 就得跟着 abort。
    const { inits } = captureFetch({ status: 1 });
    const controller = new AbortController();

    await postDocComment({
      apiUrl: API,
      botToken: "tok",
      docId: "d1",
      body: "已改好",
      signal: controller.signal,
    });

    const passed = inits[0].signal as AbortSignal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed.aborted).toBe(false);
    controller.abort(new Error("caller aborted"));
    expect(passed.aborted).toBe(true);
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

  it('字符串型失败状态 {"status":"0"} 同样必须抛错', async () => {
    // 断言的是**成功形状**而不是「不等于数字 0」。接口尚未对真实后端验证过,
    // 字符串型状态完全可能出现;只否定数字会把它放过去,直接写进去重表。
    captureFetch({ status: "0", msg: "permission denied" });

    await expect(
      postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "已改好" }),
    ).rejects.toThrow(/rejected the comment/);
  });

  it('字符串型成功状态 {"status":"1"} 视为成功', async () => {
    captureFetch({ status: "1" });

    await expect(
      postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "已改好" }),
    ).resolves.toBeUndefined();
  });

  it("信封 status = 1:正常返回", async () => {
    captureFetch({ status: 1, data: { id: 9 } });

    await expect(
      postDocComment({ apiUrl: API, botToken: "tok", docId: "d1", body: "已改好" }),
    ).resolves.toBeUndefined();
  });

  it("响应是数组:不当信封解读,也不误判为失败", async () => {
    captureFetch([{ id: 9 }]);

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

describe("isPermanentDocCommentFailure", () => {
  // 它决定 postWithRetry 要不要继续重试。没有覆盖的话,那个 break 被删掉也全绿,
  // 而 408/429 的豁免正是最容易在后续「简化」里被顺手删掉的部分。
  it("信封拒绝:确定性失败,不重试", () => {
    expect(isPermanentDocCommentFailure(new DocCommentRejectedError("rejected"))).toBe(true);
  });

  it("4xx:确定性失败,不重试", () => {
    expect(isPermanentDocCommentFailure(new Error("Octo API /x failed (404): not found"))).toBe(true);
    expect(isPermanentDocCommentFailure(new Error("Octo API /x failed (403): forbidden"))).toBe(true);
  });

  it("408 / 423 / 425 / 429 是「稍后再来」,要重试", () => {
    // 423 Locked 尤其贴题:文档正被并发编辑时后端就该这么答,而它当成确定性失败
    // 的话答复、兜底提示、去重写入会一起失败,事件还照样被 ack。
    expect(isPermanentDocCommentFailure(new Error("Octo API /x failed (408): timeout"))).toBe(false);
    expect(isPermanentDocCommentFailure(new Error("Octo API /x failed (423): locked"))).toBe(false);
    expect(isPermanentDocCommentFailure(new Error("Octo API /x failed (425): too early"))).toBe(false);
    expect(isPermanentDocCommentFailure(new Error("Octo API /x failed (429): slow down"))).toBe(false);
  });

  it("5xx 与裸网络错误要重试", () => {
    expect(isPermanentDocCommentFailure(new Error("Octo API /x failed (503): unavailable"))).toBe(false);
    expect(isPermanentDocCommentFailure(new Error("fetch failed"))).toBe(false);
  });
});
