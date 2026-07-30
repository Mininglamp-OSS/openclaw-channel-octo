/**
 * Tier-1 端到端联调（对真实 octo-server），env-gated —— 无 OCTO_E2E_* 环境变量时整组 skip，
 * 不进 CI 默认路径、不含任何密钥（凭据只从环境读）。
 *
 * 用真实 fetch 直打 D12 端点与 send/edit，验证单测 mock 不到的两件事:
 *   1. 真实 manifest 能解析出 elements/inputs/limits（wire 契约对得上 pkg/cardmsg 导出）;
 *   2. 服务端 pkg/cardmsg 真的接受我们在 advertise 后发的 ColumnSet 卡（200 而非 400），
 *      且 transient 中间帧 + 终态帧 edit 均 200。
 *
 * 跑法:
 *   OCTO_E2E_API_URL=… OCTO_E2E_BOT_TOKEN=… [OCTO_E2E_CHANNEL=… [OCTO_E2E_CHANNEL_TYPE=2]] \
 *     npx vitest run src/card-e2e.test.ts
 *   仅给 API_URL+BOT_TOKEN → 只跑只读 manifest 探测（零副作用）;
 *   再给 CHANNEL → 追加 send/edit 往返（会向该频道发一条真实进度卡）。
 */
import { describe, it, expect } from "vitest";
import {
  ackBotEvent,
  editCardMessage,
  fetchBotEvents,
  getCardProfile,
  sendCardMessage,
} from "./api-fetch.js";
import { buildInteractiveCard } from "./card-author.js";
import { deriveCardCaps, deriveInteractiveCardCaps } from "./card-caps.js";
import { parseCardAction } from "./card-action.js";
import { renderProgressCard, type CardCaps } from "./card-render.js";
import { CARD_INTERACTIVE_PROFILE, ChannelType } from "./types.js";

const API = process.env.OCTO_E2E_API_URL;
const TOKEN = process.env.OCTO_E2E_BOT_TOKEN;
const CHANNEL = process.env.OCTO_E2E_CHANNEL;
const CHANNEL_TYPE = Number(process.env.OCTO_E2E_CHANNEL_TYPE ?? ChannelType.Group);
const CARD_ACTION_E2E = process.env.OCTO_E2E_CARD_ACTION === "1";
const CARD_ACTION_TIMEOUT_MS = Number(process.env.OCTO_E2E_CARD_ACTION_TIMEOUT_MS ?? 60_000);

const suite = API && TOKEN ? describe : describe.skip;

suite("card E2E（真实 octo-server）", () => {
  it("getCardProfile:真实 manifest 可解析(elements/inputs/limits)", async () => {
    const m = await getCardProfile({ apiUrl: API!, botToken: TOKEN! });
    // eslint-disable-next-line no-console -- e2e 联调观测
    console.log("[e2e] manifest =", JSON.stringify(m, null, 2));
    expect(m.available).toBe(true);
    if (m.elements !== undefined) expect(Array.isArray(m.elements)).toBe(true);
    if (m.inputs !== undefined) expect(Array.isArray(m.inputs)).toBe(true);
  });

  const sendIt = API && TOKEN && CHANNEL ? it : it.skip;
  sendIt("send/edit/terminal 往返 + 服务端接受渲染后的卡", async () => {
    const m = await getCardProfile({ apiUrl: API!, botToken: TOKEN! });
    const caps: CardCaps = {
      ...(m.elements ? { elements: new Set(m.elements) } : {}),
      ...(m.actions ? { actions: new Set(m.actions) } : {}),
      ...(typeof m.limits?.max_nodes === "number" ? { maxNodes: m.limits.max_nodes as number } : {}),
      ...(typeof m.limits?.max_depth === "number" ? { maxDepth: m.limits.max_depth as number } : {}),
      ...(typeof m.limits?.max_payload_bytes === "number" ? { maxPayloadBytes: m.limits.max_payload_bytes as number } : {}),
    };
    // 探针:OCTO_E2E_FORCE_COLUMNS=1 时强制 advertise ColumnSet,验证 octo/v1 是否接受
    // 列布局(即便本部署 manifest 尚未 advertise elements)—— 回答"server 端上线 elements 后我们发
    // ColumnSet 会不会 400"。
    if (process.env.OCTO_E2E_FORCE_COLUMNS === "1") {
      caps.elements = new Set([...(caps.elements ?? []), "TextBlock", "ColumnSet"]);
    }
    const steps = [
      { tool: "read", status: "done" as const, summary: "/work/README.md", durationMs: 180 },
      { tool: "exec", status: "done" as const, summary: "ls -la", durationMs: 220 },
    ];
    const { card, plain } = renderProgressCard({ phase: "tool", steps }, caps);
    const done = renderProgressCard({ phase: "done", steps, elapsedMs: 1600 }, caps);
    if (m.actions?.includes("Action.ToggleVisibility")) {
      const doneJson = JSON.stringify(done.card);
      expect(doneJson).toContain("Action.ToggleVisibility");
      expect(doneJson).toContain("Show details");
      expect(doneJson).toContain("Hide details");
      expect(done.card.body).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "timeline_detail", isVisible: false }),
      ]));
    }
    // eslint-disable-next-line no-console -- e2e 联调观测
    console.log("[e2e] send card =", JSON.stringify(card));
    const res = await sendCardMessage({
      apiUrl: API!, botToken: TOKEN!, channelId: CHANNEL!, channelType: CHANNEL_TYPE, card, plain,
    });
    expect(res?.message_id).toBeTruthy();

    // transient 中间帧（不进修订历史）
    await editCardMessage({
      apiUrl: API!, botToken: TOKEN!, messageId: res!.message_id!, channelId: CHANNEL!,
      channelType: CHANNEL_TYPE, card, plain, transient: true,
    });

    // 终态帧（进修订历史）
    await editCardMessage({
      apiUrl: API!, botToken: TOKEN!, messageId: res!.message_id!, channelId: CHANNEL!,
      channelType: CHANNEL_TYPE, card: done.card, plain: done.plain,
    });
    // eslint-disable-next-line no-console -- e2e 联调观测
    console.log("[e2e] round-trip ok, message_id =", res!.message_id);
  });

  const actionIt = API && TOKEN && CHANNEL && CARD_ACTION_E2E ? it : it.skip;
  actionIt("octo/v2 发卡 → 人工点击 → events 收到 card_action", async () => {
    const manifest = await getCardProfile({ apiUrl: API!, botToken: TOKEN! });
    expect(manifest.profiles).toContain(CARD_INTERACTIVE_PROFILE);
    const built = buildInteractiveCard({
      title: "Octo P2 E2E",
      text: "请选择一个方案并提交",
      blocks: [
        { type: "section", title: "A · 体验碾压", text: "优化响应、工具调用和多端体验。" },
        { type: "section", title: "B · 垂直场景", text: "聚焦企业助手和研发 Agent。" },
        { type: "section", title: "C · 生态打法", text: "开放插件、技能和工作流模板。" },
        {
          type: "options",
          id: "strategy",
          label: "方案",
          options: [
            { title: "A · 体验碾压", value: "a" },
            { title: "B · 垂直场景", value: "b" },
            { title: "C · 生态打法", value: "c" },
          ],
        },
      ],
      buttons: [{ id: "e2e_confirm", label: "确认 E2E" }],
    }, deriveInteractiveCardCaps(manifest));
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.error);

    const existing = await fetchBotEvents({ apiUrl: API!, botToken: TOKEN!, sinceEventId: 0, limit: 100 });
    let cursor = existing.reduce((max, event) => Math.max(max, event.event_id), 0);
    const sent = await sendCardMessage({
      apiUrl: API!,
      botToken: TOKEN!,
      channelId: CHANNEL!,
      channelType: CHANNEL_TYPE,
      card: built.card,
      plain: built.plain,
      profile: CARD_INTERACTIVE_PROFILE,
    });
    expect(sent?.message_id).toBeTruthy();
    // eslint-disable-next-line no-console -- explicit human-in-the-loop E2E instruction
    console.log(`[e2e] choose a strategy and click “确认 E2E” on card message_id=${sent!.message_id} within ${CARD_ACTION_TIMEOUT_MS}ms`);

    const deadline = Date.now() + CARD_ACTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const events = await fetchBotEvents({ apiUrl: API!, botToken: TOKEN!, sinceEventId: cursor, limit: 100 });
      for (const event of events) {
        cursor = Math.max(cursor, event.event_id);
        const action = parseCardAction(event);
        if (action?.messageId === sent!.message_id && action.actionId === "e2e_confirm") {
          await ackBotEvent({ apiUrl: API!, botToken: TOKEN!, eventId: action.eventId });
          expect(action.operatorUid).toBeTruthy();
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`card_action not observed for message_id=${sent!.message_id}`);
  }, CARD_ACTION_TIMEOUT_MS + 10_000);
});
