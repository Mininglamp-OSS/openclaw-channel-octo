import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 源码守卫:inbound.ts 里不得直呼未经 IM 出站闸门包装的出站函数。
 *
 * 为什么要有它。五轮评审里,文档任务的 IM 出站漏过两次,两次都不是「守卫写错了」,
 * 而是「又多了一个出口,没人知道要给它加守卫」—— 正确性依赖一份人肉维护的出口
 * 清单,而清单漏项不会让任何东西变红。
 *
 * 这个守卫把清单变成构建期约束:出站函数只能通过 `imEgress.guard(...)` 拿到,
 * 直呼即失败,并指出行号。配合 im-egress.ts 的运行期记账,新增出口既发不出去、
 * 也过不了 CI。
 *
 * 抄自 octo-server 的 `TestEveryBotEventQueueWriterRingsTheDoorbell`,包括它那个
 * 关键设计:带下限断言 + 负向对照,保证守卫不会空转变绿。
 */

/**
 * inbound.ts 里所有会真的把内容发进 IM 的函数。
 *
 * 这份名单本身还是人肉维护的 —— 这是本守卫已知的剩余缺口。缩小它的办法:名单不写死,
 * 而是从 `./api-fetch.js` 的 import 清单里推导,凡是被引入的出站原语都必须经闸门。
 * `postJson` 就是这么被补进来的:它是裸的 POST 原语,直接
 * `postJson(..., "/v1/bot/sendMessage", ...)` 能绕开上面四个具名函数。
 */
const IM_EGRESS_FUNCTIONS = [
  "sendMessage",
  "sendMediaMessage",
  "sendTyping",
  "sendReadReceipt",
  "uploadAndSendMedia",
  "postJson",
] as const;

/**
 * 允许直呼的精确行(按整行文本匹配)。目前只有一条:`uploadAndSendMedia` 内部对
 * `sendMediaMessage` 的调用 —— 那个函数本身已经被闸门包了,内部实现不必再包一层。
 * 下面有一条测试断言白名单里的每一行都真的存在于源码中,避免它腐烂成永远为真的例外。
 */
const ALLOWED_DIRECT_CALLS = ["const result = await sendMediaMessage({"] as const;

/** 经闸门包装后的别名 —— 调用点只允许出现这些。 */
const GUARDED_ALIASES = ["imSendMessage", "imSendTyping", "imSendReadReceipt", "imUploadAndSendMedia"] as const;

/**
 * 已知的合法直呼位置:闸门绑定行本身,以及 uploadAndSendMedia 的函数声明。
 * 白名单按「整行内容」匹配而非行号,文件挪动不会让它失效。
 */
const isBindingLine = (line: string): boolean =>
  /imEgress\.guard\(/.test(line) ||
  /^export async function uploadAndSendMedia\(/.test(line) ||
  ALLOWED_DIRECT_CALLS.includes(line.trim() as (typeof ALLOWED_DIRECT_CALLS)[number]);

/** 纯函数,便于负向对照直接喂假源码。 */
export function findUnguardedImEgress(source: string): Array<{ line: number; name: string; text: string }> {
  const found: Array<{ line: number; name: string; text: string }> = [];
  source.split("\n").forEach((line, index) => {
    if (isBindingLine(line)) return;
    for (const name of IM_EGRESS_FUNCTIONS) {
      // 前置 [\w.] 排除 imSendMessage(/foo.sendMessage( 这类已包装或异对象的调用。
      if (new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(line)) {
        found.push({ line: index + 1, name, text: line.trim() });
      }
    }
  });
  return found;
}

const SOURCE = readFileSync(join(process.cwd(), "src", "inbound.ts"), "utf8");

describe("inbound.ts 的 IM 出站闸门", () => {
  it("没有任何出站函数被直呼(必须经 imEgress.guard 包装)", () => {
    const unguarded = findUnguardedImEgress(SOURCE);
    expect(
      unguarded.map((u) => `src/inbound.ts:${u.line} 直呼 ${u.name}() → ${u.text}`),
    ).toEqual([]);
  });

  it("守卫不会空转变绿:包装后的别名确实在被使用", () => {
    // 没有这条下限,把所有调用点删光也能让上一条通过。
    const counts = Object.fromEntries(
      GUARDED_ALIASES.map((alias) => [alias, (SOURCE.match(new RegExp(`(?<![\\w.])${alias}\\s*\\(`, "g")) ?? []).length]),
    );
    // 绑定行是 `const imX = imEgress.guard(...)`,别名后面不跟 `(`,所以不计入 ——
    // 下面的数字全部是真实调用点。删光调用点会让上一条测试空转,这里兜住。
    expect(counts.imSendMessage).toBeGreaterThanOrEqual(2); // 兜底通知 + 正常答复
    expect(counts.imSendTyping).toBeGreaterThanOrEqual(3); // OBOv2 / 常规 / 心跳
    expect(counts.imSendReadReceipt).toBeGreaterThanOrEqual(1); // 已读回执
    expect(counts.imUploadAndSendMedia).toBeGreaterThanOrEqual(1); // media 出站
  });

  it("负向对照:新增一个未包装的出站点会被抓到", () => {
    const fake = [
      "const imEgress = createImEgressGuard({ suppressed: docTask !== undefined, reason: '', log });",
      "const imSendMessage = imEgress.guard('sendMessage', sendMessage);",
      "await imSendMessage({ content: 'ok' });",
      "await sendMessage({ content: 'oops, 忘了走闸门' });",
    ].join("\n");

    const unguarded = findUnguardedImEgress(fake);

    expect(unguarded).toHaveLength(1);
    expect(unguarded[0]).toMatchObject({ line: 4, name: "sendMessage" });
  });

  it("白名单不会腐烂:每条允许直呼的行都仍存在于源码中", () => {
    // 白名单条目一旦对应的代码被删掉,它就变成一个永远为真的例外,
    // 下次有人写出同样的行时会被静默放过。
    const lines = new Set(SOURCE.split("\n").map((l) => l.trim()));
    for (const allowed of ALLOWED_DIRECT_CALLS) {
      expect(lines.has(allowed), `白名单已失效,源码中不存在:${allowed}`).toBe(true);
    }
  });

  it("负向对照:闸门绑定行本身不会被误报", () => {
    const onlyBindings = GUARDED_ALIASES.map(
      (alias, i) => `const ${alias} = imEgress.guard("${IM_EGRESS_FUNCTIONS[i]}", ${IM_EGRESS_FUNCTIONS[i]});`,
    ).join("\n");

    expect(findUnguardedImEgress(onlyBindings)).toEqual([]);
  });
});
