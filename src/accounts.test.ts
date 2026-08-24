import { describe, expect, it } from "vitest";
import { resolveOctoAccount } from "./accounts.js";

describe("resolveOctoAccount server-owned card policy", () => {
  it("ignores legacy local card policy fields", () => {
    const cfg = {
      channels: {
        octo: {
          botToken: "root-token",
          reasoningCardTemplateMode: "shadow",
          accounts: {
            a1: { botToken: "a1-token", reasoningCardTemplateMode: "experimental" },
            a2: { botToken: "a2-token" },
          },
        },
      },
    };

    expect(resolveOctoAccount({ cfg: cfg as never, accountId: "a1" }).config)
      .not.toHaveProperty("reasoningCardTemplateMode");
    expect(resolveOctoAccount({ cfg: cfg as never, accountId: "a2" }).config)
      .not.toHaveProperty("reasoningCardTemplateMode");
  });
});

// 文档评论 @Bot 开关的默认值。
//
// 这里才是产品默认值的所在地：channel.ts 那道 `=== true` 门禁读的是**解析之后**的
// config，而 channel-doc-task-wiring.test.ts 直接构造 config、绕过本解析器，
// 所以它钉的是门禁本身、不是默认值。两边合起来才完整。
//
// 默认开的理由：这个开关是插件本地的，服务端没有对应字段。默认关意味着用户得先知道
// 有这么个开关才能用上文档评论 @Bot，否则只会看到「@ 了没反应」。
describe("resolveOctoAccount docTasks 默认值", () => {
  const resolve = (octo: Record<string, unknown>, accountId: string) =>
    resolveOctoAccount({ cfg: { channels: { octo } } as never, accountId }).config.docTasks;

  it("两处都没配 ⇒ 默认开启", () => {
    expect(resolve({ botToken: "root", accounts: { a1: { botToken: "t" } } }, "a1")).toBe(true);
  });

  it("账号级显式 false ⇒ 关闭（保留只当普通 IM Bot 的用法）", () => {
    expect(
      resolve({ botToken: "root", accounts: { a1: { botToken: "t", docTasks: false } } }, "a1"),
    ).toBe(false);
  });

  it("channel 顶层 false 可关掉全部账号，账号级 true 仍能单独覆盖回来", () => {
    const octo = {
      botToken: "root",
      docTasks: false,
      accounts: { a1: { botToken: "t" }, a2: { botToken: "t", docTasks: true } },
    };
    expect(resolve(octo, "a1")).toBe(false);
    expect(resolve(octo, "a2")).toBe(true);
  });

  it("非布尔真值原样透传，不被兜底成 true —— 交给 channel.ts 的严格门禁拒掉", () => {
    // 兜底只对 nullish 生效。配置写错类型时要能被门禁挡下，而不是静默半开。
    expect(
      resolve({ botToken: "root", accounts: { a1: { botToken: "t", docTasks: "true" } } }, "a1"),
    ).toBe("true");
  });
});
