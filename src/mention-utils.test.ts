import { describe, it, expect } from "vitest";
import {
  parseMentions,
  extractMentionMatches,
  MENTION_PATTERN,
  STRUCTURED_MENTION_PATTERN,
  parseStructuredMentions,
  convertStructuredMentions,
  buildEntitiesFromFallback,
  extractMentionUids,
  convertContentForLLM,
  buildSenderPrefix,
  tryLongestMemberMatch,
  sanitizeOutboundMentions,
  isValidOutboundUid,
  MENTION_FORMAT_HINT,
} from "./mention-utils.js";
import type { MentionPayload } from "./types.js";

/**
 * Tests for shared @mention parsing utilities.
 * Verifies consistent behavior across different mention formats.
 *
 * Fixes: https://github.com/Mininglamp-OSS/octo-adapters/issues/31
 */
describe("parseMentions", () => {
  it("should parse English alphanumeric mentions", () => {
    const result = parseMentions("Hello @user123 and @test_user!");
    expect(result).toEqual(["user123", "test_user"]);
  });

  it("should parse Chinese character mentions", () => {
    const result = parseMentions("你好 @陈皮皮 请回复");
    expect(result).toEqual(["陈皮皮"]);
  });

  it("should parse mixed Chinese and English mentions", () => {
    const result = parseMentions("@陈皮皮 @bob_123 @托马斯");
    expect(result).toEqual(["陈皮皮", "bob_123", "托马斯"]);
  });

  it("should parse mentions with dots", () => {
    const result = parseMentions("Hi @thomas.ford how are you?");
    expect(result).toEqual(["thomas.ford"]);
  });

  it("should parse mentions with hyphens", () => {
    const result = parseMentions("CC @user-name please");
    expect(result).toEqual(["user-name"]);
  });

  it("should parse complex mixed mentions", () => {
    const result = parseMentions("@陈皮皮_test @user.name-123 @普通用户");
    expect(result).toEqual(["陈皮皮_test", "user.name-123", "普通用户"]);
  });

  it("should return empty array for no mentions", () => {
    const result = parseMentions("Hello world! No mentions here.");
    expect(result).toEqual([]);
  });

  it("should handle @all-like patterns", () => {
    const result = parseMentions("@all please check @everyone");
    expect(result).toEqual(["all", "everyone"]);
  });

  it("should handle mentions at start and end", () => {
    const result = parseMentions("@start middle @end");
    expect(result).toEqual(["start", "end"]);
  });

  it("should NOT match email addresses", () => {
    const result = parseMentions("Send to user@company.com");
    expect(result).toEqual([]);
  });

  it("行首的 @mention 应正常匹配", () => {
    const result = parseMentions("@陈皮皮 你好");
    expect(result).toEqual(["陈皮皮"]);
  });

  it("空白后的 @mention 应正常匹配", () => {
    const result = parseMentions("你好 @Bob 请看");
    expect(result).toEqual(["Bob"]);
  });
});

describe("extractMentionMatches", () => {
  it("should return matches with @ prefix", () => {
    const result = extractMentionMatches("Hello @陈皮皮 and @bob!");
    expect(result).toEqual(["@陈皮皮", "@bob"]);
  });

  it("should return empty array for no mentions", () => {
    const result = extractMentionMatches("No mentions");
    expect(result).toEqual([]);
  });
});

describe("MENTION_PATTERN", () => {
  it("should be a valid regex", () => {
    expect(MENTION_PATTERN).toBeInstanceOf(RegExp);
  });

  it("should have global flag", () => {
    expect(MENTION_PATTERN.flags).toContain("g");
  });

  it("should match Chinese characters (CJK range)", () => {
    const testStr = "@中文名字";
    const regex = new RegExp(MENTION_PATTERN.source, "g");
    const match = testStr.match(regex);
    expect(match).toEqual(["@中文名字"]);
  });

  it("should match underscores", () => {
    const testStr = "@user_name_123";
    const regex = new RegExp(MENTION_PATTERN.source, "g");
    const match = testStr.match(regex);
    expect(match).toEqual(["@user_name_123"]);
  });
});

describe("parseStructuredMentions", () => {
  it("应解析 @[uid:name] 格式", () => {
    const text = "Hi @[uid_bob:Bob] and @[uid_chen:陈皮皮]";
    const result = parseStructuredMentions(text);
    expect(result).toEqual([
      { uid: "uid_bob", name: "Bob", offset: 3, length: 14 },
      { uid: "uid_chen", name: "陈皮皮", offset: 22, length: 15 },
    ]);
    expect(text.substring(3, 3 + 14)).toBe("@[uid_bob:Bob]");
    expect(text.substring(22, 22 + 15)).toBe("@[uid_chen:陈皮皮]");
  });

  it("应处理含点号和连字符的 uid", () => {
    const text = "@[thomas.ford-1:Thomas Ford]";
    const result = parseStructuredMentions(text);
    expect(result).toEqual([
      {
        uid: "thomas.ford-1",
        name: "Thomas Ford",
        offset: 0,
        length: 28,
      },
    ]);
  });

  it("应处理32位十六进制 uid", () => {
    const text = "@[11be65096f214886b69ef9d8fcfa5c55:张三]";
    const result = parseStructuredMentions(text);
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe("11be65096f214886b69ef9d8fcfa5c55");
    expect(result[0].name).toBe("张三");
    expect(result[0].offset).toBe(0);
    expect(result[0].length).toBe(38);
  });

  it("无匹配时返回空数组", () => {
    const result = parseStructuredMentions("Hello @Bob no structured");
    expect(result).toEqual([]);
  });

  it("不应匹配含换行的格式", () => {
    const result = parseStructuredMentions("@[uid:name\nmore]");
    expect(result).toEqual([]);
  });
});

describe("convertStructuredMentions", () => {
  it("应正确转换单个 mention", () => {
    const text = "Hi @[uid_bob:Bob]!";
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe("Hi @Bob!");
    expect(result.entities).toEqual([
      { uid: "uid_bob", offset: 3, length: 4 },
    ]);
    expect(result.uids).toEqual(["uid_bob"]);
    expect(result.content.substring(3, 7)).toBe("@Bob");
  });

  it("应处理多个 mention", () => {
    const text = "@[uid_a:Alice] and @[uid_b:Bob]";
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe("@Alice and @Bob");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ uid: "uid_a", offset: 0, length: 6 });
    expect(result.entities[1]).toEqual({ uid: "uid_b", offset: 11, length: 4 });
    expect(result.content.substring(0, 6)).toBe("@Alice");
    expect(result.content.substring(11, 15)).toBe("@Bob");
  });

  it("should generate entities for all structured mentions including unknown uids", () => {
    const text = "@[fake:Bob] and @[uid_bob:Bob]";
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe("@Bob and @Bob");
    expect(result.entities).toEqual([
      { uid: "fake", offset: 0, length: 4 },
      { uid: "uid_bob", offset: 9, length: 4 },
    ]);
    expect(result.uids).toEqual(["fake", "uid_bob"]);
  });

  it("应处理中文用户名", () => {
    const text = "你好 @[uid_chen:陈皮皮] 和 @[uid_bob:Bob]";
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe("你好 @陈皮皮 和 @Bob");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 4 });
    expect(result.entities[1]).toEqual({ uid: "uid_bob", offset: 10, length: 4 });
    expect(result.content.substring(3, 7)).toBe("@陈皮皮");
    expect(result.content.substring(10, 14)).toBe("@Bob");
  });
});

describe("buildEntitiesFromFallback", () => {
  it("应从 memberMap 解析 @name", () => {
    const memberMap = new Map([
      ["陈皮皮", "uid_chen"],
      ["Bob", "uid_bob"],
    ]);
    const { entities, uids } = buildEntitiesFromFallback(
      "你好 @陈皮皮 和 @Bob",
      memberMap,
    );

    expect(uids).toEqual(["uid_chen", "uid_bob"]);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 4 });
    expect(entities[1]).toEqual({ uid: "uid_bob", offset: 10, length: 4 });
  });

  it("应忽略 memberMap 中不存在的 @name", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback(
      "@Unknown @Bob",
      memberMap,
    );

    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 9, length: 4 });
  });

  it("空 memberMap 返回空结果", () => {
    const { entities, uids } = buildEntitiesFromFallback(
      "@Bob @陈皮皮",
      new Map(),
    );
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });
});

describe("extractMentionUids", () => {
  it("应从 entities 提取 uid", () => {
    const mention: MentionPayload = {
      entities: [
        { uid: "uid_a", offset: 0, length: 4 },
        { uid: "uid_b", offset: 5, length: 4 },
      ],
      uids: ["uid_old"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });

  it("entities 全部无效时应 fallback 到 uids", () => {
    const mention: MentionPayload = {
      entities: [{} as any, null as any],
      uids: ["bot_uid"],
    };
    expect(extractMentionUids(mention)).toEqual(["bot_uid"]);
  });

  it("无 entities 时应使用 uids", () => {
    const mention: MentionPayload = {
      uids: ["uid_a", "uid_b"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });

  it("均无时返回空数组", () => {
    expect(extractMentionUids(undefined)).toEqual([]);
    expect(extractMentionUids({})).toEqual([]);
  });

  it("应过滤非 string 类型的 uid", () => {
    const mention: MentionPayload = {
      uids: ["uid_a", 123 as any, null as any, "uid_b"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });
});

describe("convertContentForLLM", () => {
  it("entities 路径：应将 @name 转换为 @[uid:name]", () => {
    const content = "你好 @陈皮皮 和 @Bob 请看下";
    const mention: MentionPayload = {
      uids: ["uid_chen", "uid_bob"],
      entities: [
        { uid: "uid_chen", offset: 3, length: 4 },
        { uid: "uid_bob", offset: 10, length: 4 },
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("你好 @[uid_chen:陈皮皮] 和 @[uid_bob:Bob] 请看下");
  });

  it("entities 无效时应 fallback 到 uids", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = {
      entities: [{} as any],
      uids: ["uid_a", "uid_b"],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@[uid_a:Alice] @[uid_b:Bob]");
  });

  it("entities offset 越界应跳过", () => {
    const content = "Hi @Bob";
    const mention: MentionPayload = {
      entities: [
        { uid: "uid_bob", offset: 3, length: 4 },
        { uid: "uid_x", offset: 100, length: 5 },
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("Hi @[uid_bob:Bob]");
  });

  it("无 mention 返回原始 content", () => {
    expect(convertContentForLLM("Hello world")).toBe("Hello world");
    expect(convertContentForLLM("Hello world", undefined)).toBe("Hello world");
  });

  it("同名用户不同 uid 应正确转换", () => {
    const content = "请 @陈皮皮 和 @陈皮皮 一起看下";
    const mention: MentionPayload = {
      uids: ["uid_chen_a", "uid_chen_b"],
      entities: [
        { uid: "uid_chen_a", offset: 2, length: 4 },
        { uid: "uid_chen_b", offset: 9, length: 4 },
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toContain("@[uid_chen_a:陈皮皮]");
    expect(result).toContain("@[uid_chen_b:陈皮皮]");
  });

  it("v1 with memberMap: known names resolved, unknown left as-is", () => {
    const content = "@Angie 你好 @阿达西不在家";
    const mention: MentionPayload = { uids: ["angie_bot", "unknown_uid"] };
    const memberMap = new Map([["Angie", "angie_bot"]]);
    const result = convertContentForLLM(content, mention, memberMap);
    expect(result).toBe("@[angie_bot:Angie] 你好 @阿达西不在家");
  });

  it("v1 without memberMap: backward compat positional pairing", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = { uids: ["uid_a", "uid_b"] };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@[uid_a:Alice] @[uid_b:Bob]");
  });

  it("v1 with email in content: email NOT matched, mentions correctly resolved", () => {
    const content = "发给xinyi@mininglamp.com 然后找 @Angie";
    const mention: MentionPayload = { uids: ["angie_bot"] };
    const memberMap = new Map([["Angie", "angie_bot"]]);
    const result = convertContentForLLM(content, mention, memberMap);
    expect(result).toContain("@[angie_bot:Angie]");
    // Email should remain unchanged (not converted to @[...] format)
    expect(result).toContain("xinyi@mininglamp.com");
    expect(result).toBe("发给xinyi@mininglamp.com 然后找 @[angie_bot:Angie]");
  });

  it("v1 with empty memberMap: no replacements", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = { uids: ["uid_a", "uid_b"] };
    const emptyMap = new Map<string, string>();
    const result = convertContentForLLM(content, mention, emptyMap);
    // Empty memberMap means hasMemberMap is false, falls back to uids
    expect(result).toBe("@[uid_a:Alice] @[uid_b:Bob]");
  });

  it("v1 with empty uids and no memberMap: returns original", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = { uids: [] };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@Alice @Bob");
  });
});

describe("buildSenderPrefix", () => {
  it("should return name(uid) when name is found", () => {
    const map = new Map([["uid1", "Alice"]]);
    expect(buildSenderPrefix("uid1", map)).toBe("Alice(uid1)");
  });

  it("should return uid when name is not found", () => {
    const map = new Map<string, string>();
    expect(buildSenderPrefix("uid1", map)).toBe("uid1");
  });
});

describe("边界情况", () => {
  it("entity.offset 超出 content 长度", () => {
    const result = convertContentForLLM("Hi", {
      entities: [{ uid: "uid", offset: 100, length: 4 }],
    });
    expect(result).toBe("Hi");
  });

  it("entity.length 为 0", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: 0, length: 0 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity.offset 为负数", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: -1, length: 4 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity.offset 或 length 为 NaN", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: NaN, length: 4 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity.offset 或 length 为 Infinity", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: 0, length: Infinity }],
    });
    expect(result).toBe("@Bob");
  });

  it("entities 数组包含 null", () => {
    const uids = extractMentionUids({
      entities: [null as any, { uid: "valid_uid", offset: 0, length: 4 }],
    });
    expect(uids).toEqual(["valid_uid"]);
  });

  it("content 在 entity.offset 处不以 @ 开头", () => {
    const result = convertContentForLLM("Hello world", {
      entities: [{ uid: "uid", offset: 0, length: 5 }],
    });
    expect(result).toBe("Hello world");
  });

  it("Emoji 用户名：UTF-16 offset/length 正确", () => {
    const content = "@张三🐱 你好";
    const mention: MentionPayload = {
      entities: [{ uid: "uid_zhang", offset: 0, length: 5 }],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@[uid_zhang:张三🐱] 你好");
  });

  it("混合 v2 + fallback 后 uids 顺序", () => {
    const text = "Hi @[uid_chen:Chen] and @Bob";
    const structured = parseStructuredMentions(text);
    const converted = convertStructuredMentions(text, structured);

    const memberMap = new Map([["Bob", "uid_bob"]]);
    const remaining = buildEntitiesFromFallback(converted.content, memberMap);

    const allEntities = [...converted.entities, ...remaining.entities];
    allEntities.sort((a, b) => a.offset - b.offset);
    const uids = allEntities.map((e) => e.uid);

    expect(uids).toEqual(["uid_chen", "uid_bob"]);
    expect(allEntities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 5 });
    expect(allEntities[1]).toEqual({ uid: "uid_bob", offset: 13, length: 4 });
  });
});

// --- extractBaseUid & resolveSenderName ---
import { extractBaseUid, resolveSenderName } from "./mention-utils.js";

describe("extractBaseUid", () => {
  it("strips space prefix", () => {
    expect(extractBaseUid("s14_abc123")).toBe("abc123");
  });

  it("handles multi-digit space id", () => {
    expect(extractBaseUid("s1234_user456")).toBe("user456");
  });

  it("returns uid unchanged when no space prefix", () => {
    expect(extractBaseUid("abc123")).toBe("abc123");
  });

  it("returns uid unchanged for 's' without underscore", () => {
    expect(extractBaseUid("system")).toBe("system");
  });

  it("does not strip non-numeric space prefix (e.g. service_bot)", () => {
    expect(extractBaseUid("service_bot")).toBe("service_bot");
    expect(extractBaseUid("support_team")).toBe("support_team");
  });
});

describe("resolveSenderName", () => {
  it("returns direct match", () => {
    const map = new Map([["s14_abc", "Alice"]]);
    expect(resolveSenderName("s14_abc", map)).toBe("Alice");
  });

  it("returns undefined when no match", () => {
    const map = new Map([["s14_abc", "Alice"]]);
    expect(resolveSenderName("s14_xyz", map)).toBeUndefined();
  });

  it("falls back to base uid (non-space entry)", () => {
    const map = new Map([["abc", "Alice"]]);
    expect(resolveSenderName("s14_abc", map)).toBe("Alice");
  });

  it("falls back to cross-space variant", () => {
    // User known as s10_abc in one space, DM from s14_abc
    const map = new Map([["s10_abc", "Alice"]]);
    expect(resolveSenderName("s14_abc", map)).toBe("Alice");
  });

  it("does not cross-space fallback for non-prefixed uid", () => {
    // uid "abc" without space prefix should not scan
    const map = new Map([["s10_abc", "Alice"]]);
    expect(resolveSenderName("abc", map)).toBeUndefined();
  });

  it("prefers direct match over cross-space", () => {
    const map = new Map([["s14_abc", "Alice-14"], ["s10_abc", "Alice-10"]]);
    expect(resolveSenderName("s14_abc", map)).toBe("Alice-14");
  });
});

describe("buildSenderPrefix with cross-space", () => {
  it("shows name(uid) for cross-space hit", () => {
    const map = new Map([["s10_abc", "Alice"]]);
    expect(buildSenderPrefix("s14_abc", map)).toBe("Alice(s14_abc)");
  });

  it("shows raw uid when no match", () => {
    const map = new Map([["s10_xyz", "Bob"]]);
    expect(buildSenderPrefix("s14_abc", map)).toBe("s14_abc");
  });
});

// ── Space-name @mention support ──────────────────────────────────────────────

describe("buildEntitiesFromFallback — 空格昵称支持", () => {
  it("应匹配含空格的昵称 @Anyang Su", () => {
    const memberMap = new Map([
      ["Anyang Su", "uid_anyang"],
      ["Bob", "uid_bob"],
    ]);
    const { entities, uids } = buildEntitiesFromFallback(
      "Hello @Anyang Su and @Bob",
      memberMap,
    );
    expect(uids).toEqual(["uid_anyang", "uid_bob"]);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({ uid: "uid_anyang", offset: 6, length: 10 });
    expect(entities[1]).toEqual({ uid: "uid_bob", offset: 21, length: 4 });
  });

  it("应优先匹配最长名称", () => {
    const memberMap = new Map([
      ["Anyang", "uid_short"],
      ["Anyang Su", "uid_full"],
    ]);
    const { entities, uids } = buildEntitiesFromFallback(
      "@Anyang Su hello",
      memberMap,
    );
    expect(uids).toEqual(["uid_full"]);
    expect(entities[0]).toEqual({ uid: "uid_full", offset: 0, length: 10 });
  });

  it("不应跨词误匹配 @Anyang Superman", () => {
    const memberMap = new Map([["Anyang Su", "uid_anyang"]]);
    const { entities, uids } = buildEntitiesFromFallback(
      "@Anyang Superman",
      memberMap,
    );
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("应处理多个空格昵称", () => {
    const memberMap = new Map([
      ["Anyang Su", "uid_anyang"],
      ["Li Wei", "uid_li"],
    ]);
    const { entities, uids } = buildEntitiesFromFallback(
      "@Anyang Su @Li Wei",
      memberMap,
    );
    expect(uids).toEqual(["uid_anyang", "uid_li"]);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({ uid: "uid_anyang", offset: 0, length: 10 });
    expect(entities[1]).toEqual({ uid: "uid_li", offset: 11, length: 7 });
  });

  it("无空格名称时行为不变", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@Bob hi", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 0, length: 4 });
  });
});

describe("buildEntitiesFromFallback — @all 跳过", () => {
  it("@all 不应生成 entity", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@all @Bob", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 5, length: 4 });
  });

  it("@All (大小写) 也不应生成 entity", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@All @Bob", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
  });

  it("@ALL 全大写不应生成 entity", () => {
    const memberMap = new Map<string, string>();
    const { entities, uids } = buildEntitiesFromFallback("@ALL please check", memberMap);
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("@all 单独出现也不应生成 entity", () => {
    const memberMap = new Map<string, string>();
    const { entities, uids } = buildEntitiesFromFallback("@all", memberMap);
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("@所有人 不应生成 entity", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@所有人 @Bob", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 5, length: 4 });
  });

  it("@所有人 单独出现也不应生成 entity", () => {
    const memberMap = new Map<string, string>();
    const { entities, uids } = buildEntitiesFromFallback("@所有人", memberMap);
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("混合 @all 和 @所有人 都不应生成 entity", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@all @所有人 @Bob", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
  });
});

describe("convertContentForLLM — 空格昵称支持", () => {
  it("v1 memberMap 路径应匹配空格昵称", () => {
    const content = "@Anyang Su 你好";
    const mention: MentionPayload = { uids: ["uid_anyang"] };
    const memberMap = new Map([["Anyang Su", "uid_anyang"]]);
    const result = convertContentForLLM(content, mention, memberMap);
    expect(result).toBe("@[uid_anyang:Anyang Su] 你好");
  });
});

describe("inbound text fallback regex", () => {
  // Must mirror the regex in inbound.ts text fallback block exactly.
  // Lookbehind: more conservative than MENTION_PATTERN — also excludes CJK
  // and extended Latin to avoid false-positive bot activations.
  function buildFallbackRegex(botName: string): RegExp {
    const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?<=^|[^\\w\\u4e00-\\u9fff\\u3040-\\u30FF\\uAC00-\\uD7AF\\u00C0-\\u024F])@${escaped}(?![\\w\\u4e00-\\u9fff\\u3040-\\u30FF\\uAC00-\\uD7AF\\u00C0-\\u024F.\\-])`
    );
  }

  // --- positive cases ---
  it("matches @BotName at start of message", () => {
    expect(buildFallbackRegex("Jeff").test("@Jeff 你好")).toBe(true);
  });

  it("matches @BotName after whitespace", () => {
    expect(buildFallbackRegex("Jeff").test("嗨 @Jeff 能帮我吗")).toBe(true);
  });

  it("matches @BotName followed by punctuation", () => {
    expect(buildFallbackRegex("Jeff").test("@Jeff，帮我看一下")).toBe(true);
  });

  it("matches @BotName followed by !", () => {
    expect(buildFallbackRegex("Jeff").test("Hello @Jeff!")).toBe(true);
  });

  it("matches CJK bot name", () => {
    expect(buildFallbackRegex("张三").test("@张三 你好")).toBe(true);
  });

  it("matches @BotName at end of string", () => {
    expect(buildFallbackRegex("Jeff").test("hey @Jeff")).toBe(true);
  });

  // --- negative: lookbehind ---
  it("does NOT match when CJK char immediately precedes @ (intentional conservative)", () => {
    expect(buildFallbackRegex("Jeff").test("你好@Jeff")).toBe(false);
  });

  it("does NOT match when underscore precedes @", () => {
    expect(buildFallbackRegex("Jeff").test("foo_@Jeff")).toBe(false);
  });

  it("does NOT match email-like foo@BotName", () => {
    expect(buildFallbackRegex("Jeff").test("foo@Jeff")).toBe(false);
  });

  // --- negative: lookahead ---
  it("does NOT match @BotName followed by word char (@Jefferson)", () => {
    expect(buildFallbackRegex("Jeff").test("@Jefferson")).toBe(false);
  });

  it("does NOT match @BotName followed by CJK", () => {
    expect(buildFallbackRegex("Jeff").test("@Jeff你好")).toBe(false);
  });

  it("does NOT match @BotName followed by dot (domain-like)", () => {
    expect(buildFallbackRegex("Jeff").test("@Jeff.com")).toBe(false);
  });

  it("does NOT match CJK bot name followed by CJK", () => {
    expect(buildFallbackRegex("小助手").test("@小助手好")).toBe(false);
  });
});

// ── Outbound mention sanitizer (P0-3) + shared format hint (P1) ──────────────

const HEX_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"; // Alice
const HEX_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"; // Bob
const HEX_C = "1234567890abcdef1234567890abcdef"; // hallucinated bare hex

describe("isValidOutboundUid", () => {
  const map = new Map<string, string>([[HEX_A, "Alice"]]);

  it("accepts a uid present in uidToNameMap", () => {
    expect(isValidOutboundUid(HEX_A, map)).toBe(true);
  });
  it("rejects the literal word 'uid'", () => {
    expect(isValidOutboundUid("uid", map)).toBe(false);
  });
  it("rejects a guessed username/bot_id", () => {
    expect(isValidOutboundUid("somebody_bot", map)).toBe(false);
  });
  it("rejects a 32-hex uid that is not in the map (hallucinated)", () => {
    expect(isValidOutboundUid(HEX_B, map)).toBe(false);
  });
  it("rejects a fake space-prefix whose base is not 32-hex", () => {
    expect(isValidOutboundUid("s1_haha", map)).toBe(false);
  });
  it("accepts a space-prefixed uid whose base IS 32-hex", () => {
    expect(isValidOutboundUid("s14_" + HEX_B, map)).toBe(true);
  });
});

describe("sanitizeOutboundMentions", () => {
  it("cold-start inline uids survive empty map (target-suffix mention path)", () => {
    // target=`group:<gid>@uid1,uid2` 抽出的 inline uid 经 params.uids 传入。
    // 正文无 @、prefetch 短路 → uidToNameMap 为空；caller 没给 entity。
    // inline uid 是框架权威意图，必须存活、被 @ 的人才能收到通知。
    const r = sanitizeOutboundMentions({
      content: "Reminder for the project team",
      entities: [],
      uids: [HEX_A, HEX_B],
      uidToNameMap: new Map(),
    });
    expect(r.uids).toEqual([HEX_A, HEX_B]);
    // caller 没给 entity 就不凭空造 entity。
    expect(r.entities).toEqual([]);
  });

  it("hallucinated bare @<hex> in body (no caller uids) is still dropped", () => {
    // HEX_C 是模型在正文里瞎编的裸 hex；caller 既没传 entity 也没传 uids。
    // 放宽 trustedUids 纳入 params.uids 后，这条防幻觉链路必须照旧拦截。
    const r = sanitizeOutboundMentions({
      content: `ping @${HEX_C} now`,
      entities: [],
      uids: [],
      uidToNameMap: new Map(),
    });
    expect(r.uids).not.toContain(HEX_C);
    expect(r.entities.some((e) => e.uid === HEX_C)).toBe(false);
  });

  it("fake space-prefix inline uid (non-hex base) is rejected, not revived", () => {
    // "s1_haha" 的 base 非 32-hex，isWellFormedUid 不认 → 不进 trustedUids。
    // 确认放宽 trustedUids 没让伪 space-prefix 复活。
    const r = sanitizeOutboundMentions({
      content: "Reminder for the project team",
      entities: [],
      uids: ["s1_haha", HEX_A],
      uidToNameMap: new Map(),
    });
    expect(r.uids).not.toContain("s1_haha");
    expect(r.uids).toContain(HEX_A);
  });

  it("bracketless @uid:name with valid (in-map) uid → @displayName + entity, no raw uid:name", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: `Hi @${HEX_A}:Alice!`,
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.content).toBe("Hi @Alice!");
    expect(r.content).not.toContain(`${HEX_A}:`);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0]).toMatchObject({ uid: HEX_A, offset: 3, length: 6 });
    expect(r.uids).toEqual([HEX_A]);
  });

  it("bracketless @uid:name where token is not uid-shaped → left untouched, no entity", () => {
    // The literal word "uid" doesn't look like a uid (not 32-hex, not in map,
    // not a real space-prefix), so the sanitizer must NOT rewrite it — leaving
    // ambiguous text intact is safer than mangling it. The only hard guarantee
    // is that no illegal mention entity leaks.
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: "Hi @uid:Alice!",
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.content).toBe("Hi @uid:Alice!");
    expect(r.entities).toHaveLength(0);
    expect(r.uids).not.toContain("uid");
  });

  it("@username with no usernameMap → left as plain text, never sent as uid", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: "Ping @somebody_bot please",
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.content).toBe("Ping @somebody_bot please");
    expect(r.entities).toHaveLength(0);
    expect(r.uids).not.toContain("somebody_bot");
  });

  it("@username with usernameMap hit → reverse-looked-up entity (P2)", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const usernameMap = new Map([["somebody_bot", HEX_A]]);
    const r = sanitizeOutboundMentions({
      content: "Ping @somebody_bot please",
      entities: [],
      uids: [],
      uidToNameMap,
      usernameMap,
    });
    expect(r.content).toBe("Ping @Alice please");
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].uid).toBe(HEX_A);
    expect(r.uids).toEqual([HEX_A]);
  });

  it("bare @<32hex> hit in uidToNameMap → @displayName + entity", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: `Hey @${HEX_A} hi`,
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.content).toBe("Hey @Alice hi");
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].uid).toBe(HEX_A);
  });

  it("bare @<32hex> not in map → @ stripped, no entity", () => {
    const uidToNameMap = new Map<string, string>();
    const r = sanitizeOutboundMentions({
      content: `Hey @${HEX_B} hi`,
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.content).toBe(`Hey ${HEX_B} hi`);
    expect(r.entities).toHaveLength(0);
    expect(r.uids).toHaveLength(0);
  });

  it("offset drift: pre-existing entity offsets stay aligned after rewrites", () => {
    // Leading converted v2 mention @Bob (entity) + a bracketless @uid:name later.
    const uidToNameMap = new Map([
      [HEX_B, "Bob"],
      [HEX_A, "Alice"],
    ]);
    const content = `@Bob ping @${HEX_A}:Alice end`;
    const r = sanitizeOutboundMentions({
      content,
      entities: [{ uid: HEX_B, offset: 0, length: 4 }],
      uids: [HEX_B],
      uidToNameMap,
    });
    expect(r.content).toBe("@Bob ping @Alice end");
    // Every entity offset must point at its @name in the rewritten content.
    for (const e of r.entities) {
      const slice = r.content.slice(e.offset, e.offset + e.length);
      expect(slice.startsWith("@")).toBe(true);
    }
    const bob = r.entities.find((e) => e.uid === HEX_B)!;
    expect(r.content.slice(bob.offset, bob.offset + bob.length)).toBe("@Bob");
    const alice = r.entities.find((e) => e.uid === HEX_A)!;
    expect(r.content.slice(alice.offset, alice.offset + alice.length)).toBe("@Alice");
  });

  it("does not damage a space-prefixed uid mention", () => {
    const spaceUid = "s14_" + HEX_A;
    const uidToNameMap = new Map([[spaceUid, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: `Hi @${spaceUid}:Alice!`,
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.content).toBe("Hi @Alice!");
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].uid).toBe(spaceUid);
    expect(r.uids).toEqual([spaceUid]);
  });

  it("space-nickname + bracketless uid", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice Smith"]]);
    const r = sanitizeOutboundMentions({
      content: `Hi @${HEX_A}:Alice Smith!`,
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.content).toBe("Hi @Alice Smith!");
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].uid).toBe(HEX_A);
    expect(r.content.slice(r.entities[0].offset, r.entities[0].offset + r.entities[0].length)).toBe(
      "@Alice Smith",
    );
  });

  it("final guard filters illegal uids out of the supplied uids list", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: "plain text no mentions",
      entities: [],
      uids: [HEX_A, "uid", "somebody_bot"],
      uidToNameMap,
    });
    expect(r.uids).toEqual([HEX_A]);
  });

  // ── Negative cases: normal colon-bearing text must NOT be mangled (#1) ──────
  describe("does not damage normal colon-bearing text", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);

    it("leaves a time like @12:30 untouched", () => {
      const r = sanitizeOutboundMentions({
        content: "lets meet @12:30 today",
        entities: [],
        uids: [],
        uidToNameMap,
      });
      expect(r.content).toBe("lets meet @12:30 today");
      expect(r.entities).toHaveLength(0);
      expect(r.uids).toHaveLength(0);
    });

    it("leaves an SSH-style git@github.com:org/repo untouched", () => {
      const r = sanitizeOutboundMentions({
        content: "deploy git@github.com:org/repo now",
        entities: [],
        uids: [],
        uidToNameMap,
      });
      expect(r.content).toBe("deploy git@github.com:org/repo now");
      expect(r.entities).toHaveLength(0);
      expect(r.uids).toHaveLength(0);
    });

    it("leaves a ratio like @3:1 untouched", () => {
      const r = sanitizeOutboundMentions({
        content: "ratio @3:1 split",
        entities: [],
        uids: [],
        uidToNameMap,
      });
      expect(r.content).toBe("ratio @3:1 split");
      expect(r.entities).toHaveLength(0);
      expect(r.uids).toHaveLength(0);
    });

    it("leaves a URL with userinfo+port untouched", () => {
      const r = sanitizeOutboundMentions({
        content: "see http://a@host:8080/p here",
        entities: [],
        uids: [],
        uidToNameMap,
      });
      expect(r.content).toBe("see http://a@host:8080/p here");
      expect(r.entities).toHaveLength(0);
      expect(r.uids).toHaveLength(0);
    });
  });

  // ── Hole B: fake space-prefix must not produce a junk uid entity (#2) ───────
  it("fake space-prefix @s1_haha:Bob → no entity with uid 's1_haha'", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: "hi @s1_haha:Bob",
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.entities.some((e) => e.uid === "s1_haha")).toBe(false);
    expect(r.uids).not.toContain("s1_haha");
  });

  // ── Hole A: hallucinated 32-hex not in map must not be sent as entity (#2) ──
  it("hallucinated @<32hex>:Ghost not in map → downgraded, no entity", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: `hi @${HEX_B}:Ghost`,
      entities: [],
      uids: [],
      uidToNameMap,
    });
    // hex is uid-shaped but not in map → downgrade to @Ghost, drop the uid.
    expect(r.content).toBe("hi @Ghost");
    expect(r.entities.some((e) => e.uid === HEX_B)).toBe(false);
    expect(r.uids).not.toContain(HEX_B);
  });

  // ── Main path must not regress: real member @[uid:Alice] (#2) ───────────────
  it("real in-map member uid is converted + kept as entity (main path)", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);
    const mentions = parseStructuredMentions(`ping @[${HEX_A}:Alice] ok`);
    const converted = convertStructuredMentions(`ping @[${HEX_A}:Alice] ok`, mentions);
    const r = sanitizeOutboundMentions({
      content: converted.content,
      entities: converted.entities,
      uids: converted.uids,
      uidToNameMap,
    });
    expect(r.content).toBe("ping @Alice ok");
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].uid).toBe(HEX_A);
    expect(r.uids).toEqual([HEX_A]);
  });

  // ── space-prefix real member with 32-hex base stays valid (#2) ─────────────
  it("real space-prefixed member @s14_<32hex> stays valid", () => {
    const spaceUid = "s14_" + HEX_A;
    const uidToNameMap = new Map([[spaceUid, "Alice"]]);
    const r = sanitizeOutboundMentions({
      content: `hi @${spaceUid}:Alice!`,
      entities: [],
      uids: [],
      uidToNameMap,
    });
    expect(r.content).toBe("hi @Alice!");
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].uid).toBe(spaceUid);
    expect(r.uids).toEqual([spaceUid]);
  });

  // ── Blocking #1: bareHex left-boundary anchor — @<32hex> embedded inside an
  // email local part / SSH URL / mailto must NOT be matched (the @ used to be
  // swallowed, corrupting the surrounding text). ──────────────────────────────
  describe("bareHex left boundary: email / SSH / mailto preserved", () => {
    const uidToNameMap = new Map([[HEX_A, "Alice"]]);

    it("email local part @<32hex> is left intact (@ not swallowed)", () => {
      const content = `mail user@${HEX_B} now`;
      const r = sanitizeOutboundMentions({
        content,
        entities: [],
        uids: [],
        uidToNameMap,
      });
      expect(r.content).toBe(content);
      expect(r.entities).toHaveLength(0);
      expect(r.uids).toHaveLength(0);
    });

    it("SSH-style git@<32hex>.com:org/repo is left intact", () => {
      const content = `clone git@${HEX_B}.com:org/repo done`;
      const r = sanitizeOutboundMentions({
        content,
        entities: [],
        uids: [],
        uidToNameMap,
      });
      expect(r.content).toBe(content);
      expect(r.entities).toHaveLength(0);
      expect(r.uids).toHaveLength(0);
    });

    it("mailto link [x](mailto:noreply@<32hex>.com) is left intact", () => {
      const content = `[click](mailto:noreply@${HEX_B}.com)`;
      const r = sanitizeOutboundMentions({
        content,
        entities: [],
        uids: [],
        uidToNameMap,
      });
      expect(r.content).toBe(content);
      expect(r.entities).toHaveLength(0);
      expect(r.uids).toHaveLength(0);
    });

    it("line-start bare @<32hex> not in map still downgrades (behavior unchanged)", () => {
      // A legitimately uid-shaped bare hex at line start (left boundary = ^) is
      // still a hallucinated, not-in-map token → @ stripped, no entity. The new
      // anchor must not regress this established behavior.
      const r = sanitizeOutboundMentions({
        content: `@${HEX_B} hello`,
        entities: [],
        uids: [],
        uidToNameMap,
      });
      expect(r.content).toBe(`${HEX_B} hello`);
      expect(r.entities).toHaveLength(0);
      expect(r.uids).toHaveLength(0);
    });
  });

  // ── Blocking #2: cold-start (empty map) structured mention must survive ──────
  it("cold start (empty uidToNameMap): structured @[uid:name] uid survives the final guard", () => {
    // prefetch failed → uidToNameMap empty. Agent wrote a correct @[uid:Alice].
    // The structured-source uid is trusted and must NOT be dropped by the guard,
    // otherwise the server receives no mention and Alice gets no notification.
    const emptyMap = new Map<string, string>();
    const input = `Hi @[${HEX_A}:Alice]!`;
    const mentions = parseStructuredMentions(input);
    const converted = convertStructuredMentions(input, mentions);
    const r = sanitizeOutboundMentions({
      content: converted.content,
      entities: converted.entities,
      uids: converted.uids,
      uidToNameMap: emptyMap,
    });
    expect(r.content).toBe("Hi @Alice!");
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].uid).toBe(HEX_A);
    expect(r.uids).toEqual([HEX_A]);
  });

  it("cold start does NOT whitewash a hallucinated bare @<32hex> (not structured-source)", () => {
    // Regression guard for the trustedUids relaxation: a bare hex produced by
    // the model (NOT via @[uid:name], so not in the trusted entities) must still
    // be stripped/downgraded even when the map is empty — it never enters
    // trustedUids, so the final guard keeps blocking it.
    const emptyMap = new Map<string, string>();
    const r = sanitizeOutboundMentions({
      content: `ping @${HEX_B} now`,
      entities: [],
      uids: [],
      uidToNameMap: emptyMap,
    });
    expect(r.content).toBe(`ping ${HEX_B} now`);
    expect(r.entities.some((e) => e.uid === HEX_B)).toBe(false);
    expect(r.uids).not.toContain(HEX_B);
  });
});

describe("MENTION_FORMAT_HINT (P1) + >10 prefix regression guard (test #13)", () => {
  it("never itself parses into an illegal {uid:'uid'} mention", () => {
    const parsed = parseStructuredMentions(MENTION_FORMAT_HINT);
    expect(parsed.every((m) => m.uid !== "uid")).toBe(true);
    // angle-bracket placeholder slots are not parseable structured mentions
    expect(parsed).toHaveLength(0);
  });

  it("uses angle-bracket placeholder slots, not the literal @[uid:displayName] trap", () => {
    expect(MENTION_FORMAT_HINT).toContain("@[<uid>:<displayName>]");
    expect(MENTION_FORMAT_HINT).not.toContain("@[uid:displayName]");
  });

  it("contains single-colon, brackets, convert promise, and three anti-patterns", () => {
    expect(MENTION_FORMAT_HINT).toContain("ONE colon");
    expect(MENTION_FORMAT_HINT).toContain("REQUIRED");
    expect(MENTION_FORMAT_HINT).toContain("I will convert");
    expect(MENTION_FORMAT_HINT).toContain("username/bot_id");
    expect(MENTION_FORMAT_HINT).toContain('"uid"');
    expect(MENTION_FORMAT_HINT).toContain("bare uid");
  });
});
