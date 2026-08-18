import { describe, expect, it } from "vitest";

import { resolveOutboundTarget } from "./target.js";
import {
  CHANNEL_ID,
  DOC_TASK_NON_ROUTABLE_PREFIX,
  isDocTaskNonRoutableTarget,
} from "./constants.js";

/**
 * P1-1 承重锁：文档任务会话**没有 IM 目标**。
 *
 * 缺陷原状：文档任务的合成 inbound 是 DM 形状的，`ctx.To` / `OriginatingTo` 直接写
 * `octo:<发起人私聊 id>`。inbound.ts 内部的 IM 出站确实被 imEgress 闸门关掉了，
 * 但那个闸门只管 inbound.ts —— agent 只要调一次 message 工具，框架侧的
 * `outbound.sendText`（channel.ts）就会拿 `ctx.to` 把文档内容发进发起人私聊。
 * 那条路不在闸门管辖范围内，闸门看不见也拦不住。
 *
 * 修法：`To` 换成不可路由哨兵，并在**出站解析的唯一入口** `resolveOutboundTarget`
 * 里 fail-closed 抛错。选这个位置而不是逐个出站点加判断，正是因为后者已经漏过一次
 * （守卫只扫 inbound.ts，channel.ts 的 sendText/sendMedia 没人管）。
 *
 * 下面每条断言都只由这个修法决定红绿：去掉 target.ts 里那段 fail-closed，
 * 「哨兵解析成功」这几条立刻变红。
 */
describe("P1-1 文档任务出站哨兵：fail-closed", () => {
  const sentinel = `${CHANNEL_ID}:${DOC_TASK_NON_ROUTABLE_PREFIX}doctask:d1:70`;

  it("哨兵目标在出站解析入口就抛错（绝不解析成任何真实会话）", () => {
    expect(() => resolveOutboundTarget(sentinel, undefined, new Set())).toThrow(
      /no IM destination/i,
    );
  });

  it("★ 哨兵不会被解析成发起人的私聊 —— 这正是泄漏的形态", () => {
    // 反向确认：如果 fail-closed 被删掉，解析器会把哨兵当普通 user 目标返回，
    // 于是 sendText 拿着它把文档内容发进 DM。这里断言「拿不到任何 channelId」。
    let resolved: { channelId: string } | undefined;
    try {
      resolved = resolveOutboundTarget(sentinel, undefined, new Set());
    } catch {
      resolved = undefined;
    }
    expect(resolved).toBeUndefined();
  });

  it("框架各层的前缀叠加不会让哨兵漏判", () => {
    // 运行时会在不同层给同一目标加 octo: / channel: / group:。只比裸串会漏判，
    // 漏判 = 哨兵被当普通目标解析 = 泄漏照旧。
    for (const target of [
      `${DOC_TASK_NON_ROUTABLE_PREFIX}doctask:d1:70`,
      `octo:${DOC_TASK_NON_ROUTABLE_PREFIX}doctask:d1:70`,
      `channel:octo:${DOC_TASK_NON_ROUTABLE_PREFIX}doctask:d1:70`,
      `group:${DOC_TASK_NON_ROUTABLE_PREFIX}doctask:d1:70`,
    ]) {
      expect(isDocTaskNonRoutableTarget(target), target).toBe(true);
      expect(() => resolveOutboundTarget(target, undefined, new Set()), target).toThrow();
    }
  });

  it("负向对照：普通 IM 目标不受影响（守卫没有误伤正常出站）", () => {
    // 没有这一条，把 resolveOutboundTarget 改成「无条件抛错」也能让上面全绿。
    const user = resolveOutboundTarget(`${CHANNEL_ID}:u_human_1`, undefined, new Set());
    expect(user.channelId).toBe("u_human_1");

    const knownGroups = new Set(["grp1"]);
    const group = resolveOutboundTarget("group:grp1", undefined, knownGroups);
    expect(group.channelId).toBe("grp1");
  });

  it("负向对照：仅仅名字里带 doctask 的真实会话不会被误杀", () => {
    // 哨兵靠的是专用前缀，不是「包含 doctask」这种子串启发式 —— 后者会把一个
    // 合法的 uid/group_no 误判成哨兵，把正常出站打死。
    expect(isDocTaskNonRoutableTarget(`${CHANNEL_ID}:u_doctask_fan_001`)).toBe(false);
    expect(() =>
      resolveOutboundTarget(`${CHANNEL_ID}:u_doctask_fan_001`, undefined, new Set()),
    ).not.toThrow();
  });
});
