import { describe, expect, it, vi } from "vitest";
import { createImEgressGuard } from "./im-egress.js";

/**
 * 闸门的**运行期**那一半。
 *
 * 上一版只有源码扫描测试,闸门本身一行没测:文档任务路径上每个被包装的调用点前面
 * 都还有一层显式的 `if (docTask)` 早返回,所以被包装的函数在任何测试里都没被调用过
 * —— 把 `if (options.suppressed)` 改成 `if (false)` 全套照绿。那正是这个闸门存在的
 * 意义所在:显式守卫漏了的时候它得兜住,而「漏了」的情形恰恰是测试里不存在的。
 */

describe("IM 出站闸门", () => {
  it("抑制时不调用底层实现,返回 undefined,并记账 + 记日志", async () => {
    const errors: string[] = [];
    const guard = createImEgressGuard({ suppressed: true, reason: "doc task d1/70", log: { error: (m) => errors.push(m) } });
    const impl = vi.fn(async () => "sent");
    const wrapped = guard.guard("sendMessage", impl);

    const result = await wrapped();

    expect(impl).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(guard.blockedCount()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("sendMessage");
    expect(errors[0]).toContain("doc task d1/70");
  });

  it("不抑制时原样放行,参数与返回值都不动", async () => {
    const guard = createImEgressGuard({ suppressed: false, reason: "" });
    const impl = vi.fn(async (a: number, b: string) => `${a}${b}`);
    const wrapped = guard.guard("sendMessage", impl);

    await expect(wrapped(1, "x")).resolves.toBe("1x");

    expect(impl).toHaveBeenCalledWith(1, "x");
    expect(guard.blockedCount()).toBe(0);
  });

  it("底层抛错时原样外抛 —— 闸门只拦不发,不改变错误语义", async () => {
    const guard = createImEgressGuard({ suppressed: false, reason: "" });
    const wrapped = guard.guard("sendMessage", async () => { throw new Error("boom"); });

    await expect(wrapped()).rejects.toThrow("boom");
  });

  it("记账跨多个被包装函数累加", async () => {
    const guard = createImEgressGuard({ suppressed: true, reason: "doc task" });
    const a = guard.guard("sendMessage", async () => {});
    const b = guard.guard("sendTyping", async () => {});

    await a();
    await b();
    await b();

    expect(guard.blockedCount()).toBe(3);
  });
});
