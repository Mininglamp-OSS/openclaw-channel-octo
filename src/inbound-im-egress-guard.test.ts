import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 源码守卫:inbound.ts 里不得直呼未经 IM 出站闸门包装的出站函数。
 *
 * 为什么要有它。评审里文档任务的 IM 出站漏过两次,两次都不是「守卫写错了」,而是
 * 「又多了一个出口,没人知道要给它加守卫」—— 正确性依赖一份人肉维护的出口清单,
 * 而清单漏项不会让任何东西变红。
 *
 * 名单**从 `./api-fetch.js` 的 import 语句里推导**,不写死。上一版写死了六个名字,
 * 而 api-fetch 还导出 `sendRichTextMessage` / `sendCardMessage` /
 * `sendTemplateCardMessage` / `editCardMessage` / `editTemplateCardMessage`,任意一个
 * 被引进来直呼都能绕开守卫 —— 那正是这个守卫要消灭的「清单漏项」本身。现在的规则是:
 * **凡是从 api-fetch 引进 inbound.ts 的发送类函数,都必须经闸门**,新增一个漏不掉。
 *
 * 抄自 octo-server 的 `TestEveryBotEventQueueWriterRingsTheDoorbell`,包括它那个关键
 * 设计:下限断言 + 负向对照,保证守卫不会空转变绿。
 */

const SRC = join(process.cwd(), "src");
const SOURCE = readFileSync(join(SRC, "inbound.ts"), "utf8");

/**
 * 从**所有** `import { … } from "./api-fetch.js"` 语句里取出实际引入的名字。
 *
 * 必须是 matchAll:非全局 exec 只解析第一条 import,而 inbound.ts 本来就有两条
 * (值导入 + `import type { GroupMember }`)。追加第三条 `import { editCardMessage }`
 * 就能让一个未包装的出站对扫描完全隐形 —— 守卫自己开的后门。
 */
export function importedApiFetchNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']\.\/api-fetch\.js["']/gs)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/**
 * 判定一个引入的名字是不是「会把内容发出去」的原语。
 *
 * 宁可多判、不可漏判:`get*` / `parse*` / `infer*` 这些只读或纯函数明确排除,
 * 其余带 send / post / edit / upload 语义的一律纳入。误判的代价只是要在
 * ALLOWED_DIRECT_CALLS 里精确豁免一行,漏判的代价是一次不受管的 IM 出站。
 */
export function isEgressName(name: string): boolean {
  return /^(send|post|edit|upload)/i.test(name) && name !== "postJsonSafe";
}

/** 本文件之外定义、但同样会发消息的本地函数(它们自己就在 inbound.ts 里)。 */
const LOCAL_EGRESS = ["uploadAndSendMedia"] as const;

/**
 * 允许直呼的精确行(按整行文本匹配,**且必须唯一**)。两条都是「已被闸门包住的函数
 * 的内部实现」,不必再包一层:
 *
 *   - `uploadAndSendMedia` → `sendMediaMessage`
 *   - `uploadMedia`(只被 `uploadAndSendMedia` 调用)→ `uploadFileToPresignedUrl`
 *
 * 用整行精确匹配而不是按函数名豁免:按名字豁免等于把这个名字永久开一个口子,
 * 按行则只放过这一处,而且下面有测试盯着它「必须存在且只出现一次」。
 */
const ALLOWED_DIRECT_CALLS = [
  "const result = await sendMediaMessage({",
  "const { url: uploadedUrl } = await uploadFileToPresignedUrl({",
] as const;

const isBindingLine = (line: string): boolean =>
  // 只认「行首的 const X = imEgress.guard(」,不再是「整行包含 imEgress.guard(」——
  // 后者可以用一句 `// imEgress.guard(` 尾注释把任意一行豁免掉。
  /^\s*const \w+ = imEgress\.guard\(/.test(line) ||
  /^export async function uploadAndSendMedia\(/.test(line) ||
  ALLOWED_DIRECT_CALLS.includes(line.trim() as (typeof ALLOWED_DIRECT_CALLS)[number]);

/** 纯函数,便于负向对照直接喂假源码。 */
export function findUnguardedImEgress(source: string): Array<{ line: number; name: string; text: string }> {
  const names = [...importedApiFetchNames(source).filter(isEgressName), ...LOCAL_EGRESS];
  const found: Array<{ line: number; name: string; text: string }> = [];
  source.split("\n").forEach((line, index) => {
    if (isBindingLine(line)) return;
    for (const name of names) {
      // 前置 [\w.] 排除 imSendMessage(/foo.sendMessage( 这类已包装或异对象的调用。
      if (new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(line)) {
        found.push({ line: index + 1, name, text: line.trim() });
      }
    }
  });
  return found;
}

describe("inbound.ts 的 IM 出站闸门", () => {
  it("名单是从 api-fetch 的 import 推导出来的,不是写死的", () => {
    const names = importedApiFetchNames(SOURCE).filter(isEgressName);
    // 下限:当前确实引入了这几个发送原语。有人新引入一个,自动进名单。
    expect(names).toEqual(expect.arrayContaining(["sendMessage", "sendMediaMessage", "sendTyping", "sendReadReceipt"]));
    // 只读/纯函数不该被误判成出站。
    expect(names).not.toContain("getGroupMembers");
    expect(names).not.toContain("inferContentType");
  });

  it("没有任何出站函数被直呼(必须经 imEgress.guard 包装)", () => {
    expect(
      findUnguardedImEgress(SOURCE).map((u) => `src/inbound.ts:${u.line} 直呼 ${u.name}() → ${u.text}`),
    ).toEqual([]);
  });

  it("守卫不会空转变绿:包装后的别名确实在被使用", () => {
    const count = (alias: string): number =>
      (SOURCE.match(new RegExp(`(?<![\\w.])${alias}\\s*\\(`, "g")) ?? []).length;
    // 绑定行是 `const imX = imEgress.guard(...)`,别名后面不跟 `(`,所以不计入 ——
    // 下面的数字全部是真实调用点。删光调用点会让上一条测试空转,这里兜住。
    expect(count("imSendMessage")).toBeGreaterThanOrEqual(2); // 兜底通知 + 正常答复
    expect(count("imSendTyping")).toBeGreaterThanOrEqual(3); // OBOv2 / 常规 / 心跳
    expect(count("imSendReadReceipt")).toBeGreaterThanOrEqual(1);
    expect(count("imUploadAndSendMedia")).toBeGreaterThanOrEqual(1);
  });

  it("白名单不会腐烂,也不能被复制成免费通行证", () => {
    const lines = SOURCE.split("\n").map((l) => l.trim());
    for (const allowed of ALLOWED_DIRECT_CALLS) {
      const hits = lines.filter((l) => l === allowed).length;
      // 存在性:条目对应的代码被删掉后,它会变成一个永远为真的例外。
      expect(hits, `白名单已失效,源码中不存在:${allowed}`).toBeGreaterThan(0);
      // 唯一性:白名单按整行文本匹配,复制一份同样的行就是一次不受管的出站。
      expect(hits, `白名单行出现了 ${hits} 次,必须唯一:${allowed}`).toBe(1);
    }
  });

  it("负向对照:新增一个未包装的出站点会被抓到", () => {
    const fake = [
      'import { sendMessage, getGroupMembers } from "./api-fetch.js";',
      "const imSendMessage = imEgress.guard('sendMessage', sendMessage);",
      "await imSendMessage({ content: 'ok' });",
      "await sendMessage({ content: 'oops, 忘了走闸门' });",
    ].join("\n");

    const unguarded = findUnguardedImEgress(fake);

    expect(unguarded).toHaveLength(1);
    expect(unguarded[0]).toMatchObject({ line: 4, name: "sendMessage" });
  });

  it("负向对照:一个**新引入**的发送函数无需改测试就会被覆盖", () => {
    // 这是写死名单最致命的漏洞:editCardMessage 打的是 /v1/bot/message/edit,
    // 既不在旧名单里,也不被任何文档任务测试的 URL 断言覆盖。
    const fake = [
      'import { sendMessage, editCardMessage } from "./api-fetch.js";',
      "const imSendMessage = imEgress.guard('sendMessage', sendMessage);",
      "await editCardMessage({ channelId: replyChannelId });",
    ].join("\n");

    expect(findUnguardedImEgress(fake)).toMatchObject([{ line: 3, name: "editCardMessage" }]);
  });

  it("负向对照:尾注释伪装成绑定行不再能豁免整行", () => {
    const fake = [
      'import { sendMessage } from "./api-fetch.js";',
      "await sendMessage({ content: '偷渡' }); // imEgress.guard(",
    ].join("\n");

    expect(findUnguardedImEgress(fake)).toHaveLength(1);
  });

  it("负向对照:第二条 import 语句里的发送函数同样会被抓到", () => {
    // 非全局 exec 只看第一条 import,追加一条就能让未包装的出站隐形。
    const fake = [
      'import { sendMessage } from "./api-fetch.js";',
      'import type { GroupMember } from "./api-fetch.js";',
      'import { editCardMessage } from "./api-fetch.js";',
      "const imSendMessage = imEgress.guard('sendMessage', sendMessage);",
      "await editCardMessage({ channelId: replyChannelId });",
    ].join("\n");

    expect(findUnguardedImEgress(fake)).toMatchObject([{ line: 5, name: "editCardMessage" }]);
  });

  it("负向对照:闸门绑定行本身不会被误报", () => {
    const fake = [
      'import { sendMessage, sendTyping } from "./api-fetch.js";',
      '  const imSendMessage = imEgress.guard("sendMessage", sendMessage);',
      '  const imSendTyping = imEgress.guard("sendTyping", sendTyping);',
    ].join("\n");

    expect(findUnguardedImEgress(fake)).toEqual([]);
  });
});
