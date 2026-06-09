/**
 * Shared @mention parsing utilities.
 * Ensures consistent mention detection across inbound and outbound code paths.
 *
 * Supports two formats:
 * - v1: @name (regex-based, positional pairing with uids)
 * - v2: @[uid:name] (structured, precise mapping via entities)
 *
 * Fixes: https://github.com/Mininglamp-OSS/octo-adapters/issues/31
 */

import type { MentionEntity, MentionPayload } from "./types.js";

/**
 * Regex pattern for matching @mentions in message content.
 *
 * 前置边界（lookbehind）：@ 前面必须是行首或非字母数字字符。
 * 使用黑名单方式 [^a-zA-Z0-9] 排除邮箱（与 v5 保持一致）。
 *
 * name 支持：字母、数字、下划线、CJK 字符、点号、连字符、重音字母。
 *
 * 捕获组说明：
 *   match[0] = 完整匹配（@name，lookbehind 不消耗字符）
 *   match[1] = name（不含 @）
 */
export const MENTION_PATTERN =
  /(?:^|(?<=\s|[^a-zA-Z0-9]))@([\w\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uAC00-\uD7AF.\-]+)/g;

/**
 * 匹配 @[uid:displayName] 格式（adapter↔LLM 内部使用）。
 *
 * uid 字符集：[\w.\-]+ — 覆盖 Octo 已知的所有 uid 格式
 * name 字符集：[^\]\n]+ — 禁止方括号和换行，其余字符均允许
 */
export const STRUCTURED_MENTION_PATTERN = /@\[([\w.\-]+):([^\]\n]+)\]/g;

/**
 * Shared @mention format instruction.
 *
 * Single source of truth reused by the inbound member-list prefix (both the
 * ≤10 and >10 branches) and the outbound message-tool hints, so the format
 * rules and anti-patterns can never drift between the three injection points.
 *
 * The placeholder slots are written as `@[<uid>:<displayName>]` (angle
 * brackets), NOT `@[uid:displayName]`. The angle brackets keep the literal
 * placeholder out of STRUCTURED_MENTION_PATTERN's uid char class ([\w.\-]),
 * so this hint text itself never parses into an illegal `{uid:"uid"}` mention
 * that a model could copy verbatim into a payload.
 */
export const MENTION_FORMAT_HINT =
  `To @mention a member, use @[<uid>:<displayName>] where <uid> is the member's REAL ` +
  `32-char hex id, with exactly ONE colon and the square brackets are REQUIRED. ` +
  `Never use a username/bot_id (e.g. @somebody_bot), never copy the literal word ` +
  `"uid", never write a bare uid without brackets, never omit the brackets. ` +
  `I will convert the @[<uid>:<displayName>] form to the correct mention before sending.`;

/**
 * Parse @mentions from message content.
 * Returns an array of mentioned names (without the @ prefix).
 *
 * @example
 * parseMentions("Hello @陈皮皮 and @bob_123!")
 * // Returns: ["陈皮皮", "bob_123"]
 */
export function parseMentions(content: string): string[] {
  const regex = new RegExp(MENTION_PATTERN.source, "g");
  const matches = content.match(regex) ?? [];
  return matches.map((m) => m.slice(1)); // Remove @ prefix
}

/**
 * Extract raw @mention matches including the @ prefix.
 * Useful when you need the full match text.
 *
 * @example
 * extractMentionMatches("Hello @陈皮皮!")
 * // Returns: ["@陈皮皮"]
 */
export function extractMentionMatches(content: string): string[] {
  const regex = new RegExp(MENTION_PATTERN.source, "g");
  return content.match(regex) ?? [];
}

// ── Structured Mention (@[uid:name]) ──────────────────────────────────────────

export interface StructuredMention {
  uid: string;
  name: string;
  /** @[uid:name] 在原始文本中的起始位置 */
  offset: number;
  /** @[uid:name] 的完整长度 */
  length: number;
}

/**
 * 解析文本中的 @[uid:name] 格式 mention。
 * 用于处理 LLM 回复中的结构化 mention。
 */
export function parseStructuredMentions(text: string): StructuredMention[] {
  const results: StructuredMention[] = [];
  const pattern = new RegExp(STRUCTURED_MENTION_PATTERN.source, "g");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      uid: match[1],
      name: match[2],
      offset: match.index,
      length: match[0].length,
    });
  }
  return results;
}

// ── Convert @[uid:name] → @name (outbound: LLM reply → human readable) ──────

export interface ConvertResult {
  /** 人类可读的 content（@[uid:name] → @name） */
  content: string;
  /** 有效 mention 的精确位置信息 */
  entities: MentionEntity[];
  /** 有效 mention 的 uid 列表（按 offset 升序，与 entities 顺序一致） */
  uids: string[];
}

/**
 * 将文本中的 @[uid:name] 转换为 @name，同时构建 entities 和 uids。
 *
 * 使用增量构建算法：按 offset 升序逐段拼接输出字符串，自然追踪每个 mention
 * 在输出中的精确位置，避免 indexOf 重扫导致的同名 mention 绑错位置问题。
 */
export function convertStructuredMentions(
  text: string,
  mentions: StructuredMention[],
): ConvertResult {
  const sorted = [...mentions].sort((a, b) => a.offset - b.offset);

  const entities: MentionEntity[] = [];
  const uids: string[] = [];
  let content = "";
  let cursor = 0;

  for (const m of sorted) {
    content += text.substring(cursor, m.offset);

    const replacement = `@${m.name}`;
    const newOffset = content.length;
    content += replacement;

    // Always generate entity for structured mentions — Structured mentions
    // are generated from the member list injected into the system prompt.
    // While the LLM could theoretically hallucinate a uid, the server will
    // reject unknown uids, and filtering here causes cache-miss false
    // negatives that are worse than the low risk of hallucinated uids.
    // Note: if the LLM hallucinates a uid that happens to be a real (but
    // unintended) user, that user receives one unexpected notification.
    // This risk is negligible given Octo uids are random 32-char hex hashes.
    entities.push({
      uid: m.uid,
      offset: newOffset,
      length: replacement.length,
    });
    uids.push(m.uid);

    cursor = m.offset + m.length;
  }

  content += text.substring(cursor);

  return { content, entities, uids };
}

// ── Build entities from plain @name (fallback path) ──────────────────────────

/** Name character class — mirrors MENTION_PATTERN's inner char set (without space) */
const NAME_CHAR_RE =
  /[\w\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uAC00-\uD7AF.\-]/;

/**
 * 从 @atPos 位置尝试匹配 memberMap 中最长的名称（支持含空格昵称）。
 * sortedNames 必须按长度降序排列。
 *
 * 边界检查：匹配到的名称末尾之后的字符必须是终止字符（非"名字字符"），
 * 防止 @Anyang Su 从 "@Anyang Superman" 中误匹配。
 */
export function tryLongestMemberMatch(
  text: string,
  atPos: number,
  memberMap: Map<string, string>,
  sortedNames: string[],
): { name: string; uid: string } | undefined {
  const after = text.substring(atPos + 1);
  for (const candidate of sortedNames) {
    if (after.startsWith(candidate)) {
      const ch = text[atPos + 1 + candidate.length];
      if (ch === undefined || !NAME_CHAR_RE.test(ch)) {
        const uid = memberMap.get(candidate);
        if (uid) return { name: candidate, uid };
      }
    }
  }
  return undefined;
}

/**
 * 从纯 @name 格式的文本中构建 entities（fallback 路径）。
 * 通过 memberMap（displayName → uid）解析每个 @name 对应的 uid。
 *
 * 依赖 MENTION_PATTERN 的捕获组：match[1] 为 name（不含 @）。
 * lookbehind 不消耗字符，因此 match.index 直接指向 @ 的位置。
 */
export function buildEntitiesFromFallback(
  content: string,
  memberMap: Map<string, string>,
): { entities: MentionEntity[]; uids: string[] } {
  const entities: MentionEntity[] = [];
  const uids: string[] = [];

  const pattern = new RegExp(MENTION_PATTERN.source, "g");
  let match;

  // 按长度降序排列，优先匹配最长名称
  const sortedNames = [...memberMap.keys()].sort((a, b) => b.length - a.length);

  while ((match = pattern.exec(content)) !== null) {
    const name = match[1];

    // Skip @all / @All etc. — handled separately as mentionAll, not as entity
    if (name.toLowerCase() === "all" || name === "所有人") continue;

    let uid: string | undefined;
    let matchedName = name;

    // 优先尝试最长前缀匹配（支持含空格昵称）
    const longer = tryLongestMemberMatch(
      content, match.index, memberMap, sortedNames,
    );
    if (longer) {
      uid = longer.uid;
      matchedName = longer.name;
    } else {
      // 回退到精确正则匹配
      uid = memberMap.get(name);
    }

    if (!uid) continue;

    const atName = `@${matchedName}`;
    entities.push({ uid, offset: match.index, length: atName.length });
    uids.push(uid);

    // 跳过完整匹配长度，防止空格名称被部分重复匹配
    pattern.lastIndex = match.index + atName.length;
  }

  return { entities, uids };
}

// ── Outbound mention sanitizer (last-line guard before send) ─────────────────

/** Octo uids are random 32-char hex hashes. */
const HEX32_RE = /^[0-9a-fA-F]{32}$/;

/**
 * 判定一个 uid 是否可作为出站 mention 发出。
 *
 * 白名单（保守策略，与 bareHex 兜底分支口径一致）：
 *   1. 在 uidToNameMap 中命中（v2 主路径的真实成员 uid 走这里放行）。
 *   2. space-prefixed（s{digits}_<base>）且剥离后的 base 为标准 32-hex。
 *
 * 故意 **不** 放行"未命中 map 的裸 32-hex"：模型幻觉出的随机 32-hex 不在本
 * 群成员表里，若放行会被当 entity 发给服务端（幻觉提醒）。bareHex 兜底分支
 * 对未命中 hex 已采取"剥掉 @、不发 mention"的保守处理，这里与之统一。
 *
 * 其余（字面词 "uid"、猜测的 username/bot_id、伪 space-prefix 如 s1_haha）
 * 一律视为非法。
 */
export function isValidOutboundUid(
  uid: string,
  uidToNameMap: Map<string, string>,
): boolean {
  if (uidToNameMap.has(uid)) return true;
  // space-prefixed uid（s14_<32hex>）：base 必须是标准 32-hex 才算合法，
  // 避免伪造的 s1_haha 这类"能剥就放行"导致垃圾 uid entity 泄露。
  const base = extractBaseUid(uid);
  if (base !== uid && HEX32_RE.test(base)) return true;
  return false;
}

/**
 * 形态预筛：判断 token 是否"长得像一个 uid"，决定出站兜底是否要触碰这段文本。
 *
 * 比 isValidOutboundUid 略宽——额外把"裸 32-hex"也算 uid 形态，使得
 * `@<32hex>:Name`（即便 hex 未命中 map）能进入重写路径并降级为 `@Name`，
 * 而 `@12:30`/`@3:1`/`git@github.com:org` 这类普通含冒号文本（token 形态完全
 * 不像 uid）被直接跳过、原样保留，不做任何改写。
 */
function isUidShaped(uid: string, uidToNameMap: Map<string, string>): boolean {
  if (isValidOutboundUid(uid, uidToNameMap)) return true;
  if (HEX32_RE.test(uid)) return true; // 裸 32-hex（可能未命中 map）
  return false;
}

export interface SanitizeResult {
  content: string;
  entities: MentionEntity[];
  uids: string[];
}

/**
 * 出站宽松兜底 + 守卫：在 v2/v1 转换之后、send 之前调用。
 *
 * 修复三类模型常写错、转换/兜底都救不回的坏 @：
 *   1. 缺方括号 `@uid:name`  —— uid 合法 → 重写 `@displayName` + entity；
 *      非法 → 降级 `@name`（剥掉 uid），绝不发 `uid:name` 整段。
 *   2. `@username`/猜测句柄  —— 有 usernameMap 命中 → 反查补 entity；
 *      否则保持纯文本（无 entity），绝不把非法 token 当 uid。
 *   3. 裸 `@<32hex>`         —— 命中 uidToNameMap → 重写 `@displayName` + entity；
 *      未命中 → 剥掉 `@`，不发非法 mention。
 *
 * 最终守卫：过滤 entities/uids，保留 isValidOutboundUid 通过、或来自结构化
 * `@[uid:name]` 形式（传入的 entities，形态合法）的可信 uid。详见函数内
 * trustedUids 注释——结构化来源是 agent 的权威意图，冷启动空 map 下也放行；
 * 兜底分支新产生的幻觉 hex 不可信，仍被拦截。
 *
 * 重写改变字符串长度，故所有改写统一从后向前 splice，并同步调整既有
 * entity 的 offset，避免漂移。
 */
export function sanitizeOutboundMentions(params: {
  content: string;
  entities: MentionEntity[];
  uids: string[];
  uidToNameMap: Map<string, string>;
  // 预留：@username → uid 反查表（P2 能力）。当前生产路径尚未接线（仅测试
  // 传入），故 ③ 分支线上不可达；接入后即可对 @handle 自动补 entity。
  usernameMap?: Map<string, string>;
}): SanitizeResult {
  const { uidToNameMap, usernameMap } = params;
  let content = params.content;
  // 既有 entity 的工作副本（offset 会随重写调整）
  const entities: MentionEntity[] = params.entities.map((e) => ({ ...e }));

  // 可信 uid 集合：两个来源都来自 caller 入参，都是框架/agent 的权威意图：
  //   1. params.entities —— 来自 convertStructuredMentions，即 agent 显式写出的
  //      @[uid:name] 结构化形式；
  //   2. params.uids —— 由框架从 target 后缀（group:<gid>@uid1,uid2）等渠道抽出
  //      的 inline mention uid（正文里没有 @，但调用方明确要 @ 这些人）。
  // 两者都应被信任，即便冷启动下 uidToNameMap 为空（prefetch best-effort 失败、
  // 正文无 @ 而短路）也要放行，否则真实成员的合法 mention 会被最终守卫误删、对
  // 方收不到通知。
  //
  // 关键区分：只信任**来自 caller 入参**的 uid（params.entities + params.uids），
  // 且仅当其形态合法（裸 32-hex 或 space-prefixed 32-hex base）。sanitize 内部由
  // bracketless/bareHex 兜底分支**新产生**、push 进局部 entities 的 uid 不进此集
  // 合——那些可能源自模型瞎编的幻觉 hex，仍须经 isValidOutboundUid 校验，照旧被
  // 守卫/降级。
  const isWellFormedUid = (uid: string): boolean =>
    HEX32_RE.test(extractBaseUid(uid));
  const trustedUids = new Set<string>(
    [...params.entities.map((e) => e.uid), ...params.uids].filter(
      isWellFormedUid,
    ),
  );
  const passesFinalGuard = (uid: string): boolean =>
    isValidOutboundUid(uid, uidToNameMap) || trustedUids.has(uid);

  interface Edit {
    start: number;
    end: number;
    replacement: string;
    uid?: string;
  }
  const edits: Edit[] = [];

  // 已被既有 entity / 已决定的 edit 占用的区间，避免重复处理同一段文本
  const claimed: Array<[number, number]> = entities.map((e) => [
    e.offset,
    e.offset + e.length,
  ]);
  const overlaps = (s: number, e: number): boolean =>
    claimed.some(([cs, ce]) => s < ce && e > cs);

  // 前置短路：正文不含 @ 时无需扫描任何 mention 形态（出站群消息正文绝大多数
  // 没有 @）。最终 uid/entity 守卫仍会执行（见末尾），故传入的 uids 仍被过滤。
  if (content.includes("@")) {
    // ① 缺方括号 @uid:name（name 字符集复用 MENTION_PATTERN 的内部集合）
    // 前置边界对齐 MENTION_PATTERN：@ 前须为行首/空白/非字母数字，排除
    // git@github.com:org、http://x@host:8080 这类中缀 @ 误匹配。
    const bracketless =
      /(?:^|(?<=\s|[^a-zA-Z0-9]))@([\w.\-]+):([\wÀ-ɏ一-鿿぀-ヿ가-힯.\-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = bracketless.exec(content)) !== null) {
      const uidTok = m[1];
      if (uidTok.toLowerCase() === "all") continue;
      // 形态预筛：只有"确实像一个 uid"的 token 才进入重写/降级。普通含冒号
      // 文本（@12:30 时间、@3:1 比例、github.com 等）形态不像 uid → 原样保留。
      if (!isUidShaped(uidTok, uidToNameMap)) continue;
      const start = m.index;
      let end = m.index + m[0].length;
      if (overlaps(start, end)) continue;

      const canonical =
        uidToNameMap.get(uidTok) ??
        (extractBaseUid(uidTok) !== uidTok
          ? uidToNameMap.get(extractBaseUid(uidTok))
          : undefined);

      let replacement: string;
      let uid: string | undefined;
      if (isValidOutboundUid(uidTok, uidToNameMap)) {
        // 合法 uid → 重写为真名（优先用映射的规范名）+ entity
        const dispName = canonical ?? m[2];
        // 含空格昵称：若冒号后紧跟规范名，扩展消费范围把整段名字吃掉
        const colonEnd = start + 1 + uidTok.length + 1; // @ + uid + ':'
        if (canonical && content.startsWith(canonical, colonEnd)) {
          end = colonEnd + canonical.length;
        }
        replacement = `@${dispName}`;
        uid = uidTok;
      } else {
        // 形态像 uid 但不合法（如未命中 map 的幻觉 32-hex）→ 降级为 @name
        //（剥掉 uid 段），不发非法 mention。
        replacement = `@${m[2]}`;
        uid = undefined;
      }
      edits.push({ start, end, replacement, uid });
      claimed.push([start, end]);
    }

    // ② 裸 @<32hex>
    // 前置边界对齐 ①/MENTION_PATTERN：@ 前须为行首/空白/非字母数字。缺这个
    // 锚点时，email 本地部分、SSH URL、mailto 里的 `@<32hex>` 会被误匹配并
    // 损坏（user@<hex>、git@<hex>.com:org、mailto:noreply@<hex>.com）。
    // lookbehind/^ 均为零宽，m.index 仍指向 @、m[0] 仍以 @ 开头，故下方
    // start/end/claimed 计算与既有逻辑完全一致，无需调整。
    const bareHex = /(?:^|(?<=\s|[^a-zA-Z0-9]))@([0-9a-fA-F]{32})/g;
    while ((m = bareHex.exec(content)) !== null) {
      const hex = m[1];
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      const name = uidToNameMap.get(hex);
      if (name) {
        edits.push({ start, end, replacement: `@${name}`, uid: hex });
      } else {
        // 未命中 → 剥掉 @，不当作 mention 发出
        edits.push({ start, end, replacement: hex, uid: undefined });
      }
      claimed.push([start, end]);
    }

    // ③ @username（仅当 usernameMap 命中时反查补回；否则保持纯文本）
    if (usernameMap && usernameMap.size > 0) {
      const userPat = /@([a-zA-Z0-9_]+)/g;
      while ((m = userPat.exec(content)) !== null) {
        const username = m[1];
        if (username.toLowerCase() === "all") continue;
        const start = m.index;
        const end = m.index + m[0].length;
        if (overlaps(start, end)) continue;
        const uid = usernameMap.get(username);
        if (!uid) continue;
        const name = uidToNameMap.get(uid) ?? username;
        edits.push({ start, end, replacement: `@${name}`, uid });
        claimed.push([start, end]);
      }
    }
  }

  // 从后向前应用所有 edit，同步调整既有/新增 entity 的 offset
  edits.sort((a, b) => b.start - a.start);
  for (const ed of edits) {
    const delta = ed.replacement.length - (ed.end - ed.start);
    content = content.slice(0, ed.start) + ed.replacement + content.slice(ed.end);
    for (const e of entities) {
      if (e.offset >= ed.end) e.offset += delta;
    }
    if (ed.uid) {
      entities.push({
        uid: ed.uid,
        offset: ed.start,
        length: ed.replacement.length,
      });
    }
  }

  // 最终守卫：丢弃非法 uid 的 entity / uid。
  // 放行条件 = isValidOutboundUid（in-map / space-prefixed 32-hex base）
  //          OR  结构化来源的可信 uid（trustedUids，已预筛形态合法）。
  // 这样冷启动下结构化 @[uid:name] 的真实 uid（未命中空 map）能存活，而兜底
  // 分支新产生的幻觉 hex（不在 trustedUids）仍被拦截。
  const finalEntities = entities
    .filter((e) => passesFinalGuard(e.uid))
    .sort((a, b) => a.offset - b.offset);

  const seen = new Set<string>();
  const finalUids: string[] = [];
  for (const e of finalEntities) {
    if (!seen.has(e.uid)) {
      seen.add(e.uid);
      finalUids.push(e.uid);
    }
  }
  for (const u of params.uids) {
    if (passesFinalGuard(u) && !seen.has(u)) {
      seen.add(u);
      finalUids.push(u);
    }
  }

  return { content, entities: finalEntities, uids: finalUids };
}

/**
 * 兼容提取 mention 中的 uid 列表。
 *
 * 优先级：
 * 1. entities 中有效条目的 uid → 使用
 * 2. entities 全部无效 → fallback 到 uids
 * 3. uids 也无效 → 返回空数组
 */
export function extractMentionUids(mention?: MentionPayload): string[] {
  if (!mention) return [];

  if (mention.entities && Array.isArray(mention.entities)) {
    const validUids = mention.entities
      .filter(
        (e): e is MentionEntity =>
          e != null &&
          typeof e === "object" &&
          !Array.isArray(e) &&
          typeof e.uid === "string",
      )
      .map((e) => e.uid);

    if (validUids.length > 0) return validUids;
  }

  if (mention.uids && Array.isArray(mention.uids)) {
    return mention.uids.filter((uid): uid is string => typeof uid === "string");
  }

  return [];
}

// ── Convert @name → @[uid:name] for LLM context ─────────────────────────────

/**
 * 将历史消息中的 @name 转换为 @[uid:name] 格式，供 LLM 理解 mention 语义。
 *
 * 路径优先级：
 * 1. entities 有效 → 精确替换（v2）
 * 2. entities 无效 / 不存在 → memberMap 查找（优先）或 uids 顺序配对（v1 fallback）
 * 3. 无 mention → 返回原始 content
 *
 * 替换从后向前进行，避免 offset 漂移。
 */
export function convertContentForLLM(
  content: string,
  mention?: MentionPayload,
  memberMap?: Map<string, string>,
): string {
  if (!mention) return content;

  // 尝试用 entities（v2）
  if (mention.entities && Array.isArray(mention.entities)) {
    const validEntities = mention.entities.filter(
      (e): e is MentionEntity =>
        e != null &&
        typeof e === "object" &&
        !Array.isArray(e) &&
        typeof e.uid === "string" &&
        typeof e.offset === "number" &&
        typeof e.length === "number" &&
        Number.isFinite(e.offset) &&
        Number.isFinite(e.length) &&
        e.offset >= 0 &&
        e.length > 0 &&
        e.offset + e.length <= content.length,
    );

    if (validEntities.length > 0) {
      const sorted = [...validEntities].sort((a, b) => b.offset - a.offset);
      let result = content;
      for (const entity of sorted) {
        const original = result.substring(
          entity.offset,
          entity.offset + entity.length,
        );
        if (!original.startsWith("@")) continue;
        const name = original.substring(1);
        const replacement = `@[${entity.uid}:${name}]`;
        result =
          result.substring(0, entity.offset) +
          replacement +
          result.substring(entity.offset + entity.length);
      }
      return result;
    }
  }

  // fallback（v1）: memberMap 查找优先，无 memberMap 时退回 uids 顺序配对
  const hasMemberMap = memberMap && memberMap.size > 0;
  const hasUids = mention.uids && Array.isArray(mention.uids) && mention.uids.length > 0;

  if (hasMemberMap || hasUids) {
    let result = content;
    const pattern = new RegExp(MENTION_PATTERN.source, "g");
    let match;
    let i = 0;
    const replacements: {
      start: number;
      end: number;
      replacement: string;
    }[] = [];

    // 按长度降序排列，优先匹配最长名称
    const sortedNames = hasMemberMap
      ? [...memberMap!.keys()].sort((a, b) => b.length - a.length)
      : [];

    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      let uid: string | undefined;
      let matchedName = name;

      if (hasMemberMap) {
        // 优先尝试最长前缀匹配（支持含空格昵称）
        const longer = tryLongestMemberMatch(
          content, match.index, memberMap!, sortedNames,
        );
        if (longer) {
          uid = longer.uid;
          matchedName = longer.name;
        } else {
          uid = memberMap!.get(name);
        }
      } else if (hasUids && i < mention.uids!.length) {
        const candidate = mention.uids![i];
        uid = typeof candidate === "string" ? candidate : undefined;
        i++;
      }

      if (uid) {
        replacements.push({
          start: match.index,
          end: match.index + 1 + matchedName.length,
          replacement: `@[${uid}:${matchedName}]`,
        });
      }

      // 跳过完整匹配长度
      if (matchedName.length > name.length) {
        pattern.lastIndex = match.index + 1 + matchedName.length;
      }
    }

    for (let j = replacements.length - 1; j >= 0; j--) {
      const r = replacements[j];
      result =
        result.substring(0, r.start) +
        r.replacement +
        result.substring(r.end);
    }
    return result;
  }

  return content;
}

// ── Sender prefix utility ────────────────────────────────────────────────────

/**
/**
 * Extract the base uid from a space-prefixed uid.
 * "s14_abc123" → "abc123", "abc123" → "abc123"
 */
export function extractBaseUid(uid: string): string {
  // Space-prefixed format: s{digits}_{baseUid}
  const match = uid.match(/^s(\d+)_(.+)$/);
  if (match) return match[2];
  return uid;
}

/**
 * Resolve sender display name from uidToNameMap with cross-space fallback.
 * 1. Direct lookup: uidToNameMap.get(from_uid)
 * 2. Base uid fallback: strip space prefix and scan map for matching base uid
 *    (covers DM users who appear in groups under a different space prefix)
 */
export function resolveSenderName(
  fromUid: string,
  uidToNameMap: Map<string, string>,
): string | undefined {
  // Direct hit (same space or no space prefix)
  const direct = uidToNameMap.get(fromUid);
  if (direct) return direct;

  // Cross-space fallback: extract base uid and scan
  const baseUid = extractBaseUid(fromUid);
  if (baseUid !== fromUid) {
    // Check if the base uid itself is in the map (non-space account)
    const baseHit = uidToNameMap.get(baseUid);
    if (baseHit) return baseHit;

    // Scan for any space-prefixed variant with the same base uid
    for (const [uid, name] of uidToNameMap) {
      if (extractBaseUid(uid) === baseUid) return name;
    }
  }

  return undefined;
}

export function buildSenderPrefix(
  fromUid: string,
  uidToNameMap: Map<string, string>,
): string {
  const name = resolveSenderName(fromUid, uidToNameMap);
  return name ? `${name}(${fromUid})` : fromUid;
}
