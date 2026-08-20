// 工具错误播报不得以「答复」身份进文档评论区。
//
// 背景（2026-08-19 实测两次，17:38 与 17:57）：真答复先投递，26ms 后又来一条
// `⚠️ 🛠️ Exec failed: …`，把 agent 敲的原始命令暴露给了文档读者。
//
// 为什么原来的判据拦不住：插件当时要求 `isError && SDK 元数据标记`，而那个标记的置位
// 条件是 `lastToolError.middlewareError === true` —— 只覆盖中间件错误。exec 类工具失败
// 天然没有这个标记，于是判成「不是工具警告」，走了普通 final 分支。
//
// 现在只看 isError：SDK 构造回复项时对工具错误播报固定写 isError: true，助手答复项
// 永远不带（同一段代码用 `!item.isError` 把答复挑出来做 transcript 归属）。
import { describe, it, expect } from "vitest";
import { __testing } from "./inbound.js";

const { isFallbackOnlyToolWarningFinal, sanitizeToolErrorNoticeText } = __testing;

const noMedia = { text: "x" } as const;

describe("工具错误播报的识别（按 isError，不靠图标/正文形态）", () => {
  it("exec 类失败：没有 SDK 元数据标记，也必须被拦下延后", () => {
    // 这正是 17:38/17:57 漏网的那种 payload：isError 为真，但元数据标记缺席。
    const payload = {
      text: "⚠️ 🛠️ Exec failed: # 列出我能访问的文档 octo-cli --bot-id … html list",
      isError: true,
    };
    expect(isFallbackOnlyToolWarningFinal(payload as never)).toBe(true);
  });

  it("助手的真答复不受影响 —— 这是不改成「只许一条 final」的原因", () => {
    const first = { text: "✅ **已完成！** 已将「智能 Agent 协作」改为「智能体协作」" };
    const second = { text: "补充说明：另外我把第二段的措辞也统一了。" };
    expect(isFallbackOnlyToolWarningFinal(first as never)).toBe(false);
    expect(isFallbackOnlyToolWarningFinal(second as never)).toBe(false);
  });

  it("正文里提到 failed 的正常答复不会被误拦（不做正文匹配）", () => {
    const payload = { text: "这次没成功，原因是 Exec failed 时缺少 aid。" };
    expect(isFallbackOnlyToolWarningFinal(payload as never)).toBe(false);
  });

  it("isError 显式为 false 时按答复处理", () => {
    expect(isFallbackOnlyToolWarningFinal({ ...noMedia, isError: false } as never)).toBe(false);
  });
});

// 延后 ≠ 丢弃:整回合没有别的产出时,这条警告会作为兜底 notice 发出去,而 notice 对
// 文档任务就是**公开评论区**。只把 intent 改成 notice 改的是状态账,不改内容 ——
// 原始命令行(可能带着 Bearer / ?code=)还是会原样落进评论。所以兜底前要净化。
describe("兜底 notice 的净化(sanitizeToolErrorNoticeText)", () => {
  it("★ 砍掉冒号后的命令行 —— 这正是本 PR 要堵的暴露面", () => {
    const raw = "⚠️ 🛠️ Exec failed: # 列出我能访问的文档 octo-cli --bot-id … html list";
    const out = sanitizeToolErrorNoticeText(raw);
    expect(out).not.toContain("octo-cli");
    expect(out).not.toContain("--bot-id");
    // 但仍要让读者知道「是工具失败了」,不能净化成一片空白。
    // 头部是 SDK 原样的英文短语(`Exec failed`),净化只在其后接一句中文说明。
    expect(out).toContain("Exec failed");
    expect(out).toContain("详情见日志");
  });

  it("★ 命令行里夹带的凭证不会漏出去", () => {
    const raw =
      "⚠️ 🛠️ Exec failed: curl -H 'Authorization: Bearer sk-live-abc123' https://x/docs-html/d/a?code=s3cr3t";
    const out = sanitizeToolErrorNoticeText(raw);
    expect(out).not.toContain("sk-live-abc123");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("code=");
    expect(out).not.toContain("Bearer");
  });

  it("多行 stderr 只留首行的头部", () => {
    const raw = "⚠️ 🛠️ Exec failed: rm -rf /tmp/x\nstderr: permission denied\n  at /Users/someone/secret";
    const out = sanitizeToolErrorNoticeText(raw);
    expect(out).not.toContain("permission denied");
    expect(out).not.toContain("/Users/someone");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("★ 首行没有冒号时,不许把后面几行的详情捞上来当头部", () => {
    // 上面那条钉不住「先截首行」——它的第一个冒号本来就在首行,截不截结果一样。
    // 这条才区分:若在整串上找冒号,head 会变成「首行 + \nstderr」,把详情带出去。
    const raw = "⚠️ 🛠️ Exec failed\nstderr: permission denied at /Users/someone/secret";
    const out = sanitizeToolErrorNoticeText(raw);
    expect(out).not.toContain("stderr");
    expect(out).not.toContain("permission denied");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("★ 助手级错误面(API/计费/中断)不带工具前缀,必须原样保留", () => {
    // SDK 对这类也写 isError: true,但那是真正面向用户的内容,砍掉就成了哑巴。
    const raw = "请求上游模型失败：账户余额不足，请充值后重试。";
    expect(sanitizeToolErrorNoticeText(raw)).toBe(raw);
  });

  it("没有冒号的工具播报保持原样(不误伤)", () => {
    const raw = "⚠️ 🛠️ Exec failed";
    expect(sanitizeToolErrorNoticeText(raw)).toBe("⚠️ 🛠️ Exec failed（详情见日志）");
  });
});
