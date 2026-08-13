/**
 * Outbound target parsing.
 *
 * Lives in its own dependency-free module (only `types.js`) so both the message
 * action layer and the progress-card layer can resolve a target without pulling
 * in `actions.ts` — that would close a `card-progress → actions → inbound →
 * card-progress` import cycle.
 */
import { ChannelType } from "./types.js";
import { stripAllChannelPrefixes, isDocTaskNonRoutableTarget } from "./constants.js";

const THREAD_SEP = "____";

/**
 * Parse a target string into channelId + channelType.
 *
 * Explicit prefixes (`group:` / `user:`) always win.
 * For bare IDs, we check `knownGroupIds` to determine the channel type.
 */
export function parseTarget(
  target: string,
  // Kept as a positional placeholder: every caller already passes it (mostly as
  // `undefined`) and it is part of the exported shape. It takes no part in the
  // verdict — bare-id classification goes through `knownGroupIds` alone.
  _currentChannelId?: string,
  knownGroupIds?: Set<string>,
): { channelId: string; channelType: ChannelType } {
  // Explicit prefixes always win
  if (target.startsWith("group:")) {
    const channelId = target.slice(6);
    // groupNo____shortId → CommunityTopic
    if (channelId.includes(THREAD_SEP)) {
      return { channelId, channelType: ChannelType.CommunityTopic };
    }
    return { channelId, channelType: ChannelType.Group };
  }
  // OpenClaw's delivery pipeline can emit `channel:<id>` as a parallel alias
  // for group channels (#232 review: "channel: 支持下沉到 parseTarget"). Handle
  // it here so every caller — outbound adapter, message tool, etc — sees
  // consistent routing without having to normalise upstream first.
  if (target.startsWith("channel:")) {
    const channelId = target.slice(8);
    if (channelId.includes(THREAD_SEP)) {
      return { channelId, channelType: ChannelType.CommunityTopic };
    }
    return { channelId, channelType: ChannelType.Group };
  }
  if (target.startsWith("user:"))
    return { channelId: target.slice(5), channelType: ChannelType.DM };

  // Strip octo: channel-namespace prefix if present
  let bareId = target;
  if (bareId.startsWith("octo:")) bareId = bareId.slice(5);

  // Thread channel ID (groupNo____shortId)
  if (bareId.includes(THREAD_SEP)) {
    return { channelId: bareId, channelType: ChannelType.CommunityTopic };
  }

  // Bare ID: check knownGroupIds, also check parent group for thread context
  const isGroup = knownGroupIds?.has(bareId) ?? false;
  return { channelId: bareId, channelType: isGroup ? ChannelType.Group : ChannelType.DM };
}

/**
 * Canonicalise an outbound delivery target prefix.
 *
 * OpenClaw's delivery pipeline can emit several equivalent shapes for the same
 * channel-group target (`group:<id>`, `channel:<id>`, `octo:<id>`), and the
 * agent-tool / multi-bot routing layer occasionally produces stacked forms
 * such as `"group:octo:grp1"` or `"channel:octo:grp1"`. Without canonical
 * collapse, the downstream parseTarget would only strip one leading prefix and
 * mis-parse the stacked inner segment as part of the group id
 * (`"group:octo:grp1"` → channelId `"octo:grp1"` → message routed to
 * the wrong group). The recursive collapse below makes the guard at handleSend
 * (which uses stripAllChannelPrefixes) and this delivery path agree on the
 * canonical bare groupId.
 *
 * Rules:
 *   - `octo:` namespace prefix → resolve by its INNER shape, never by the
 *     generic group fallback. `octo:` alone carries no user/group semantics, so
 *     the bare form (`octo:<id>`) must be left for parseTarget/knownGroupIds to
 *     classify. Collapsing `octo:<uid>` (a DM) to `group:<uid>` would send
 *     channel_type=2 for a DM id and the server rejects it (query_failed / 400).
 *   - No leading channel-namespace prefix at all → pass through (bare IDs,
 *     thread channel IDs like `grp1____x`, and other shapes parseTarget
 *     handles natively).
 *   - Stacked channel-namespace prefix wrapping a `user:` DM (e.g.
 *     `"octo:user:uid123"`) → unwrap to clean `user:uid123` so the DM path
 *     fires correctly.
 *   - An explicit `group:`/`channel:` token anywhere (after any leading `octo:`)
 *     means a group/channel target → recursively collapse and re-prefix as a
 *     single `group:` (so parseTarget sees ONE known shape and the group: arm of
 *     resolveOutboundOctoTarget can strip any `@mention` suffix).
 *   - Only an `octo:` namespace prefix with no group/channel/user hint
 *     (`octo:<id>`) is ambiguous: return the collapsed bare id and let
 *     parseTarget/knownGroupIds classify it (known group → Group, else DM). Do
 *     NOT default it to group — that would send channel_type=2 for a DM id and
 *     the server rejects it (query_failed / 400).
 */
export function normalizeOutboundChannelPrefix(ctxTo: string): string {
  const bare = stripAllChannelPrefixes(ctxTo);
  // No leading channel-namespace prefix to strip — let parseTarget handle it
  // natively (bare groupNo, `grp1____x` thread refs, `user:<uid>` DMs).
  if (bare === ctxTo) return ctxTo;
  // `user:` DM marker survives stripAllChannelPrefixes (it never strips user:) —
  // route as DM, not a group with `user:` embedded in the channelId.
  if (bare.startsWith("user:")) return bare;
  // Distinguish an explicit group/channel target from a bare `octo:<id>`. Strip
  // only the leading `octo:` runs, then look for a group:/channel: marker.
  const afterOcto = ctxTo.replace(/^(?:octo:)+/, "");
  if (afterOcto.startsWith("group:") || afterOcto.startsWith("channel:")) {
    // Explicit group/channel (possibly stacked) — canonicalise to one `group:`.
    return "group:" + bare;
  }
  // Bare `octo:<id>` — no user/group hint. Return the collapsed bare id so
  // parseTarget/knownGroupIds decides (known group → Group, otherwise DM).
  return bare;
}

/**
 * Resolve an outbound delivery target from the framework's ChannelOutboundContext.
 *
 * OpenClaw passes thread/sub-topic replies as `to: "group:<group_no>"` + a separate
 * `threadId: "<short_id>"` field. parseTarget by itself never sees threadId, so a
 * bare call to parseTarget collapses thread routing back to the parent group
 * (channelType=2 instead of 5) and drops the short_id entirely. This helper merges
 * the two into the proper CommunityTopic channel_id (`<group_no>____<short_id>`,
 * channel_type=5) so outbound messages land in the thread, not the parent group.
 *
 * Also strips the inline mention UID suffix ("group:<id>@uid1,uid2" → "group:<id>")
 * before parsing — mention-UID extraction remains the caller's responsibility.
 *
 * Idempotent: if ctx.to already carries `____` (caller synthesised the thread id
 * themselves), the threadId merge is skipped.
 */
export function resolveOutboundTarget(
  ctxTo: string,
  threadId?: string | number | null,
  knownGroupIds?: Set<string>,
): { channelId: string; channelType: ChannelType } {
  const THREAD_SEP = "____";

  // Fail-closed on the doc-task sentinel. 文档任务的会话上下文里 `ctx.to` 是一个
  // 不可路由的哨兵(见 constants.ts),因为那类回合的产出只能回评论区、绝不能进 IM。
  // 这道检查放在**出站解析的唯一入口**,而不是逐个出站点加判断:后者正是此前
  // 漏掉 channel.ts 的 sendText/sendMedia 的原因 —— 守卫只扫 inbound.ts,框架自己
  // 那条出站路没人管。这里抛错 ⇒ 任何走 resolveOutboundTarget 的出站(现在的和以后
  // 新增的)都够不到真实会话,agent 调 message 工具只会拿到一个明确的失败。
  if (isDocTaskNonRoutableTarget(ctxTo)) {
    throw new Error(
      "octo: document-comment task sessions have no IM destination — replies must go to the doc comment thread, not a chat target",
    );
  }

  // Normalise `channel:<id>` to `group:<id>` so downstream parseTarget sees a
  // shape it knows. See normalizeOutboundChannelPrefix for rationale.
  let targetForParse = normalizeOutboundChannelPrefix(ctxTo);

  // Strip inline mention-UID suffix before parsing.
  if (targetForParse.startsWith("group:")) {
    const groupPart = targetForParse.slice(6);
    const atIdx = groupPart.indexOf("@");
    if (atIdx >= 0) targetForParse = "group:" + groupPart.slice(0, atIdx);
  }

  const parsed = parseTarget(targetForParse, undefined, knownGroupIds);

  // Fail-fast on a target that resolves to an empty channel — BEFORE the
  // threadId merge below. parseTarget yields channelId="" for "", "group:",
  // "user:", "group:@uid" (mention-only), etc. The framework outbound path
  // (sendText/sendMedia) would otherwise POST channel_id="" and the server
  // answers an opaque 500. The check must run here and not at the end: "group:"
  // parses to {channelId:"", channelType:Group}, so a following threadId merge
  // would synthesise a non-empty "____<short_id>" and slip past any end-of-
  // function guard. A non-empty parsed channel can only grow longer through the
  // merge, never become empty, so one check here covers every case. (#138)
  if (!parsed.channelId.trim()) {
    throw new Error(
      "octo: outbound target resolves to an empty channel — a valid channel/user target is required",
    );
  }

  // Merge framework-provided threadId only when ctx.to was a bare group — if the
  // caller already encoded the thread via "____" in ctx.to, parsed.channelType
  // is already CommunityTopic and we pass through.
  if (threadId != null && parsed.channelType === ChannelType.Group) {
    const shortId = stripAllChannelPrefixes(String(threadId));
    if (!shortId) return parsed;

    // Defensive: if threadId already contains `____`, validate its parent
    // prefix matches the group parsed from ctx.to. Mismatch would route
    // delivery to a different group entirely (cross-channel leak via stale
    // or corrupted thread id). Prefer silently ignoring the threadId and
    // staying on the explicit ctx.to parent over honouring an inconsistent
    // pair — the caller's ctx.to is the stronger signal of intent.
    if (shortId.includes(THREAD_SEP)) {
      const shortIdParent = shortId.slice(0, shortId.indexOf(THREAD_SEP));
      if (shortIdParent !== parsed.channelId) {
        return parsed;
      }
      return { channelId: shortId, channelType: ChannelType.CommunityTopic };
    }

    return {
      channelId: `${parsed.channelId}${THREAD_SEP}${shortId}`,
      channelType: ChannelType.CommunityTopic,
    };
  }

  return parsed;
}

/** 子区 channelId(`<group>____<short>`)的父群;非子区原样返回。 */
export function parentGroupOf(channelId: string): string {
  const sep = channelId.indexOf(THREAD_SEP);
  return sep >= 0 ? channelId.slice(0, sep) : channelId;
}

/**
 * `scope:"parent"` 的目标折叠。发送路径**先**做这一步(早于 threadId 合并与 in-thread 重路由):
 * group-like target 去掉 `____<short_id>` 与内联 `@uid`,重写成 `group:<parent>`。DM 不适用 ——
 * scope 对私聊无意义,折叠会把 `user:<uid>` 误判成群。
 *
 * 归属判定必须复用同一折叠,否则「发送落到哪」两边算不出同一个答案。返回 null 表示不适用。
 */
export function collapseParentScope(
  target: string,
  knownGroupIds?: Set<string>,
): string | null {
  const { channelType } = parseTarget(
    normalizeOutboundChannelPrefix(target),
    undefined,
    knownGroupIds,
  );
  if (channelType === ChannelType.DM) return null;
  const bareParent = parentGroupOf(
    stripAllChannelPrefixes(target).replace(/^([^@]+)@.*$/, "$1"),
  );
  return `group:${bareParent}`;
}
