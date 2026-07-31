/**
 * IM 出站能力闸门。
 *
 * 背景:文档任务的一切用户可见输出都必须落到评论区,一条都不能进 IM。此前靠在
 * 每个出站点手写 `if (docTask)` 守卫来保证,五轮评审里漏过两次 —— 因为「出口清单」
 * 是人肉维护的,新增一个出口没有任何机制会变红。
 *
 * 这里把出站函数统一包一层:被抑制时不发、只记账并记一条 error 日志。于是
 *
 *   - 运行期:忘记加守卫的新出口**发不出去**,退化成静默 + 日志,而不是污染 IM;
 *   - 构建期:`inbound-im-egress-guard.test.ts` 扫源码,禁止在 inbound.ts 里直呼
 *     未经本闸门包装的出站函数,并带下限断言防止空转变绿。
 *
 * 刻意不抛异常:几处出站是 fire-and-forget(`.catch(() => {})`),抛出去会被吞掉,
 * 记账反而抓得住 —— 失败路径测试直接断言 `blockedCount() === 0`。
 */
export interface ImEgressGuardOptions {
  /** true = 本次入站不允许任何 IM 出站(当前仅文档任务)。 */
  suppressed: boolean;
  /** 写进日志的抑制原因,便于定位是哪条路径漏了守卫。 */
  reason: string;
  log?: { error?: (message: string) => void };
}

export interface ImEgressGuard {
  /** 包装一个出站函数;被抑制时返回 undefined 且不调用底层实现。 */
  guard<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R | undefined>;
  /** 被拦下的出站次数。正常路径恒为 0 —— 非 0 即代表有出口漏了收口。 */
  blockedCount(): number;
}

export function createImEgressGuard(options: ImEgressGuardOptions): ImEgressGuard {
  let blocked = 0;
  return {
    guard<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) {
      return async (...args: A): Promise<R | undefined> => {
        if (options.suppressed) {
          blocked += 1;
          options.log?.error?.(
            `octo: IM egress ${name} suppressed (${options.reason}) — route this output through the doc task outbound chokepoint`,
          );
          return undefined;
        }
        return fn(...args);
      };
    },
    blockedCount: () => blocked,
  };
}
