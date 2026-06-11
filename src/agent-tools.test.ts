import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./accounts.js", () => ({
  listOctoAccountIds: vi.fn(),
  resolveOctoAccount: vi.fn(),
  resolveDefaultOctoAccountId: vi.fn(),
}));

vi.mock("./api-fetch.js", () => ({
  fetchBotGroups: vi.fn(),
  getGroupInfo: vi.fn(),
  getGroupMembers: vi.fn(),
  getGroupMd: vi.fn(),
  updateGroupMd: vi.fn(),
  getVoiceContext: vi.fn(),
  updateVoiceContext: vi.fn(),
  deleteVoiceContext: vi.fn(),
  getThreadMd: vi.fn(),
  updateThreadMd: vi.fn(),
  resolveSecret: vi.fn(),
  resolveTargetsByName: vi.fn(),
}));

vi.mock("./group-md.js", () => ({
  broadcastGroupMdUpdate: vi.fn(),
  broadcastThreadMdUpdate: vi.fn(),
  getKnownGroupIds: vi.fn(() => new Set()),
}));

// NOTE: only mkdir from node:fs/promises is wrapped (see the vi.mock below); all
// other fs calls run for real. The write-secret tests exercise the real
// path-confinement + write path against an OS temp directory so that traversal /
// absolute-escape / symlink rejection is genuinely tested.

// NOTE: node:fs/promises is passed through to the REAL implementation for every
// call EXCEPT mkdir, which is wrapped in a vi.fn that delegates to the genuine
// mkdir by default. The write-secret tests still exercise real path-confinement
// + write against an OS temp directory (so traversal / absolute-escape / symlink
// rejection is genuinely tested); the wrapper only lets the intermediate-dir
// TOCTOU regression test inject a symlink swap in the race window between
// mkdir() and open().
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

import { createOctoManagementTools, _clearResolveCache } from "./agent-tools.js";
import {
  listOctoAccountIds,
  resolveOctoAccount,
  resolveDefaultOctoAccountId,
} from "./accounts.js";
import {
  fetchBotGroups,
  getGroupInfo,
  getGroupMembers,
  getGroupMd,
  updateGroupMd,
  getVoiceContext,
  updateVoiceContext,
  deleteVoiceContext,
  getThreadMd,
  updateThreadMd,
  resolveSecret,
  resolveTargetsByName,
} from "./api-fetch.js";
import { broadcastGroupMdUpdate, broadcastThreadMdUpdate, getKnownGroupIds } from "./group-md.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";

// Minimal config stub — mocked account functions don't inspect it
const mockCfg = { channels: { octo: { botToken: "tok-secret" } } } as any;

function setupMocks(overrides?: {
  enabled?: boolean;
  configured?: boolean;
  botToken?: string;
  apiUrl?: string;
  secretsFileRoot?: string;
}) {
  const {
    enabled = true,
    configured = true,
    botToken = "tok-secret",
    apiUrl = "http://api.test",
    secretsFileRoot,
  } = overrides ?? {};

  vi.mocked(listOctoAccountIds).mockReturnValue(["default"]);
  vi.mocked(resolveDefaultOctoAccountId).mockReturnValue("default");
  vi.mocked(resolveOctoAccount).mockReturnValue({
    accountId: "default",
    enabled,
    configured,
    config: {
      botToken,
      apiUrl,
      pollIntervalMs: 2000,
      heartbeatIntervalMs: 30000,
      ...(secretsFileRoot ? { secretsFileRoot } : {}),
    },
  });
}

/** Create tool and return its execute function */
function getExecute() {
  const tools = createOctoManagementTools({ cfg: mockCfg });
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("octo_management");
  return tools[0].execute as (
    id: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

function parseText(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------

describe("createOctoManagementTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  // -----------------------------------------------------------------------
  // tool creation
  // -----------------------------------------------------------------------
  describe("tool creation", () => {
    it("returns empty array when cfg is undefined", () => {
      expect(createOctoManagementTools({ cfg: undefined })).toEqual([]);
    });

    it("returns empty array when no account has botToken", () => {
      setupMocks({ botToken: "" });
      expect(createOctoManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when account is disabled", () => {
      setupMocks({ enabled: false });
      expect(createOctoManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when account is not configured", () => {
      setupMocks({ configured: false });
      expect(createOctoManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when listOctoAccountIds throws", () => {
      vi.mocked(listOctoAccountIds).mockImplementation(() => {
        throw new Error("bad config");
      });
      expect(createOctoManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns octo_management as the only tool", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("octo_management");
      expect(typeof tools[0].execute).toBe("function");
    });
  });

  // -----------------------------------------------------------------------
  // list-groups
  // -----------------------------------------------------------------------
  describe("execute — list-groups", () => {
    it("returns groups on success", async () => {
      vi.mocked(fetchBotGroups).mockResolvedValue([
        { group_no: "g1", name: "Alpha" },
        { group_no: "g2", name: "Beta" },
      ]);
      const result = await getExecute()("tc", { action: "list-groups" });
      const data = parseText(result);
      expect(data.groups).toHaveLength(2);
      expect(data.groups[0].group_no).toBe("g1");
    });

    it("returns error on API failure", async () => {
      vi.mocked(fetchBotGroups).mockRejectedValue(new Error("Network error"));
      const result = await getExecute()("tc", { action: "list-groups" });
      const data = parseText(result);
      expect(data.error).toContain("list-groups failed");
    });
  });

  // -----------------------------------------------------------------------
  // group-info
  // -----------------------------------------------------------------------
  describe("execute — group-info", () => {
    it("returns group info on success", async () => {
      vi.mocked(getGroupInfo).mockResolvedValue({
        group_no: "g1",
        name: "Alpha",
        member_count: 5,
      });
      const result = await getExecute()("tc", {
        action: "group-info",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.group_no).toBe("g1");
      expect(data.name).toBe("Alpha");
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-info" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error on API failure", async () => {
      vi.mocked(getGroupInfo).mockRejectedValue(new Error("404"));
      const result = await getExecute()("tc", {
        action: "group-info",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.error).toContain("group-info failed");
    });
  });

  // -----------------------------------------------------------------------
  // group-members
  // -----------------------------------------------------------------------
  describe("execute — group-members", () => {
    it("returns members on success", async () => {
      vi.mocked(getGroupMembers).mockResolvedValue([
        { uid: "u1", name: "Alice" },
        { uid: "u2", name: "Bob", role: "admin" },
      ]);
      const result = await getExecute()("tc", {
        action: "group-members",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.members).toHaveLength(2);
      expect(data.members[0].name).toBe("Alice");
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-members" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-read
  // -----------------------------------------------------------------------
  describe("execute — group-md-read", () => {
    it("returns GROUP.md content on success", async () => {
      vi.mocked(getGroupMd).mockResolvedValue({
        content: "# Rules\nBe nice.",
        version: 3,
        updated_at: "2024-01-01",
        updated_by: "admin",
      });
      const result = await getExecute()("tc", {
        action: "group-md-read",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.content).toBe("# Rules\nBe nice.");
      expect(data.version).toBe(3);
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-md-read" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-update
  // -----------------------------------------------------------------------
  describe("execute — group-md-update", () => {
    it("updates and calls broadcastGroupMdUpdate", async () => {
      vi.mocked(updateGroupMd).mockResolvedValue({ version: 7 });
      const result = await getExecute()("tc", {
        action: "group-md-update",
        groupId: "g1",
        content: "# Updated",
      });
      const data = parseText(result);
      expect(data.updated).toBe(true);
      expect(data.version).toBe(7);
      expect(broadcastGroupMdUpdate).toHaveBeenCalledWith({
        accountId: "default",
        groupNo: "g1",
        content: "# Updated",
        version: 7,
      });
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "group-md-update",
        content: "# New",
      });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error when content is missing", async () => {
      const result = await getExecute()("tc", {
        action: "group-md-update",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.error).toContain("content");
    });
  });

  // -----------------------------------------------------------------------
  // accountId resolution
  // -----------------------------------------------------------------------
  describe("accountId resolution", () => {
    it("uses provided accountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["default", "acct2"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId: accountId ?? "default",
        enabled: true,
        configured: true,
        config: {
          botToken: "tok-acct2",
          apiUrl: "http://api2.test",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "acct2" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api2.test",
        botToken: "tok-acct2",
      });
    });

    it("single-account: force-routes to the only configured account", async () => {
      // Default mock setup has listOctoAccountIds returning a single "test-account".
      // No accountId passed — the single-account branch short-circuits directly to
      // knownIds[0], bypassing resolveDefaultOctoAccountId.
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("single-account: force-routes even when the LLM passes a different accountId", async () => {
      // Single-account → whatever the LLM passes is ignored; the only configured
      // account wins. Guards against a stray/hallucinated accountId silently
      // failing auth.
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "test-account" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("case-insensitive accountId match normalises to the real config key", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue([
        "27lZl4QjPzh72d10c8c_bot",
        "other_bot",
      ]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      // LLM drops the capitals — should still hit the mixed-case config key.
      await execute("tc", { action: "list-groups", accountId: "27lzl4qjpzh72d10c8c_bot" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-27lZl4QjPzh72d10c8c_bot.test",
        botToken: "tok-27lZl4QjPzh72d10c8c_bot",
      });
    });

    it("exact-case match wins even if a case-fold variant also exists", async () => {
      // Pathological but legal: two accountIds differ only in casing.
      // Passing the exact one must hit the exact one, not whichever the
      // lowercase collapse happens to find first.
      vi.mocked(listOctoAccountIds).mockReturnValue(["BotA", "bota"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "BotA" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-BotA.test",
        botToken: "tok-BotA",
      });
    });

    it("case-fold ambiguity (no exact match) is rejected, not silently resolved", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["BotA", "bota"]);
      const execute = getExecute();
      // Neither exact; lowercased collapses to same key hitting both.
      const result = await execute("tc", { action: "list-groups", accountId: "BOTA" });
      const data = parseText(result);
      expect(data.error).toContain("ambiguous");
      expect(data.error).toContain("BotA");
      expect(data.error).toContain("bota");
      expect(fetchBotGroups).not.toHaveBeenCalled();
    });

    it("multi-account: unresolvable accountId returns error with available options", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-a", "bot-b"]);
      const execute = getExecute();
      const result = await execute("tc", {
        action: "list-groups",
        accountId: "does-not-exist",
      });
      const data = parseText(result);
      expect(data.error).toContain("Account not found: does-not-exist");
      expect(data.error).toContain("bot-a");
      expect(data.error).toContain("bot-b");
    });

    it("multi-account: no accountId and no default returns error with available options", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-a", "bot-b"]);
      vi.mocked(resolveDefaultOctoAccountId).mockReturnValue(null as any);
      const execute = getExecute();
      const result = await execute("tc", { action: "list-groups" });
      const data = parseText(result);
      expect(data.error).toContain("Multiple Octo accounts");
      expect(data.error).toContain("bot-a");
      expect(data.error).toContain("bot-b");
      // Must NOT silently pick an account and make the call.
      expect(fetchBotGroups).not.toHaveBeenCalled();
    });

    it('multi-account: accountId="default" alias behaves as unspecified → error when no default resolvable', async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-a", "bot-b"]);
      vi.mocked(resolveDefaultOctoAccountId).mockReturnValue(null as any);
      const execute = getExecute();
      const result = await execute("tc", { action: "list-groups", accountId: "default" });
      const data = parseText(result);
      expect(data.error).toContain("Multiple Octo accounts");
      expect(fetchBotGroups).not.toHaveBeenCalled();
    });

    it("resolves correct account in multi-account setup", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              botToken: "tok-secondary",
              apiUrl: "http://api-secondary.test",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          };
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            botToken: "tok-primary",
            apiUrl: "http://api-primary.test",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        };
      });

      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "secondary" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });
  });

  // -----------------------------------------------------------------------
  // agentAccountId resolution
  // -----------------------------------------------------------------------
  describe("agentAccountId resolution", () => {
    it("uses agentAccountId when args.accountId is not provided", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-A", "bot-B"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);

      const tools = createOctoManagementTools({ cfg: mockCfg, agentAccountId: "bot-A" });
      const execute = tools[0].execute as any;
      await execute("tc", { action: "list-groups" });

      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-bot-A.test",
        botToken: "tok-bot-A",
      });
    });

    it("args.accountId takes priority over agentAccountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-A", "bot-B"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);

      const tools = createOctoManagementTools({ cfg: mockCfg, agentAccountId: "bot-A" });
      const execute = tools[0].execute as any;
      await execute("tc", { action: "list-groups", accountId: "bot-B" });

      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-bot-B.test",
        botToken: "tok-bot-B",
      });
    });

    it("falls back to resolveDefault when agentAccountId is undefined", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["bot-A", "bot-B"]);
      vi.mocked(resolveDefaultOctoAccountId).mockReturnValue("bot-B");
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);

      const tools = createOctoManagementTools({ cfg: mockCfg, agentAccountId: undefined });
      const execute = tools[0].execute as any;
      await execute("tc", { action: "list-groups" });

      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-bot-B.test",
        botToken: "tok-bot-B",
      });
    });
  });

  // -----------------------------------------------------------------------
  // parameter validation
  // -----------------------------------------------------------------------
  describe("parameter validation", () => {
    it("returns error for unknown action", async () => {
      const result = await getExecute()("tc", { action: "do-magic" });
      const data = parseText(result);
      expect(data.error).toContain("Unknown action");
    });

    it("returns error when action is missing", async () => {
      const result = await getExecute()("tc", {});
      const data = parseText(result);
      expect(data.error).toContain("Unknown action");
    });
  });

  // -----------------------------------------------------------------------
  // token security
  // -----------------------------------------------------------------------
  describe("token security", () => {
    it("tool schema does not contain botToken", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      const schema = JSON.stringify(tools[0].parameters);
      expect(schema).not.toContain("botToken");
    });

    it("successful results do not leak botToken", async () => {
      vi.mocked(fetchBotGroups).mockResolvedValue([{ group_no: "g1", name: "G1" }]);
      const result = await getExecute()("tc", { action: "list-groups" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });

    it("error results do not leak botToken", async () => {
      const execute = getExecute();
      // After tool creation, change mock so execute sees no botToken
      vi.mocked(resolveOctoAccount).mockReturnValue({
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          botToken: undefined,
          apiUrl: "http://api.test",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      });
      const result = await execute("tc", { action: "list-groups" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });
  });

  // -----------------------------------------------------------------------
  // voice-context actions
  // -----------------------------------------------------------------------
  describe("voice-context actions", () => {
    // -- Schema tests --

    it("tool schema includes voice-context-* actions", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      const schema = tools[0].parameters;
      const actionEnum = schema.properties.action.enum;
      expect(actionEnum).toContain("voice-context-read");
      expect(actionEnum).toContain("voice-context-update");
      expect(actionEnum).toContain("voice-context-delete");
    });

    it("tool description mentions voice correction context", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      expect(tools[0].description).toContain("voice correction context");
    });

    // Token leak prevention
    it("tool schema does not contain botToken", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      const schema = JSON.stringify(tools[0].parameters);
      expect(schema).not.toContain("botToken");
      expect(schema).not.toContain("tok-secret");
    });

    // -- voice-context-read tests --

    it("voice-context-read returns normalized result", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "correction terms",
        updated_at: "2026-04-09T13:00:00+08:00",
      });

      const result = await getExecute()("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.has_context).toBe(true);
      expect(parsed.context).toBe("correction terms");
      expect(parsed.updated_at).toBe("2026-04-09T13:00:00+08:00");
      // No status field in result
      expect(parsed.status).toBeUndefined();
    });

    it("voice-context-read calls getVoiceContext with correct params", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: false,
        context: "",
        updated_at: "",
      });

      await getExecute()("tc", { action: "voice-context-read" });

      expect(getVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("voice-context-read result does not leak botToken", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "terms",
        updated_at: "",
      });

      const result = await getExecute()("tc", { action: "voice-context-read" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });

    it("voice-context-read wraps API errors in makeError", async () => {
      vi.mocked(getVoiceContext).mockRejectedValue(
        new Error("Bot API GET /v1/bot/voice/context failed (401): invalid token"),
      );

      const result = await getExecute()("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("voice-context-read failed");
      // Error must not leak token
      expect(parsed.error).not.toContain("tok-secret");
    });

    // -- voice-context-update tests --

    it("voice-context-update succeeds with valid content", async () => {
      vi.mocked(updateVoiceContext).mockResolvedValue(undefined);

      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "new correction terms",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.updated).toBe(true);
      expect(updateVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
        content: "new correction terms",
      });
    });

    // Empty string rejection tests

    it("voice-context-update rejects undefined content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        // content not provided
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects null content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: null,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects empty string content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects whitespace-only content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "   \t\n  ",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update wraps API errors", async () => {
      vi.mocked(updateVoiceContext).mockRejectedValue(
        new Error("Bot API PUT /v1/bot/voice/context failed (400): context exceeds max length"),
      );

      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "x".repeat(10001),
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("voice-context-update failed");
    });

    // -- voice-context-delete tests --

    it("voice-context-delete succeeds", async () => {
      vi.mocked(deleteVoiceContext).mockResolvedValue(undefined);

      const result = await getExecute()("tc", { action: "voice-context-delete" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.deleted).toBe(true);
      expect(deleteVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("voice-context-delete wraps API errors", async () => {
      vi.mocked(deleteVoiceContext).mockRejectedValue(
        new Error("Bot API DELETE /v1/bot/voice/context failed (401): invalid token"),
      );

      const result = await getExecute()("tc", { action: "voice-context-delete" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("voice-context-delete failed");
    });

    // Multi-account tests

    it("voice-context-read uses specified accountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: false,
        context: "",
        updated_at: "",
      });

      await getExecute()("tc", {
        action: "voice-context-read",
        accountId: "secondary",
      });

      expect(getVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });

    it("voice-context-update uses specified accountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(updateVoiceContext).mockResolvedValue(undefined);

      await getExecute()("tc", {
        action: "voice-context-update",
        content: "terms",
        accountId: "secondary",
      });

      expect(updateVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
        content: "terms",
      });
    });

    it("voice-context-delete uses specified accountId", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(deleteVoiceContext).mockResolvedValue(undefined);

      await getExecute()("tc", {
        action: "voice-context-delete",
        accountId: "secondary",
      });

      expect(deleteVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });

    // Token not leaked on multi-account calls
    it("multi-account results do not leak secondary botToken", async () => {
      vi.mocked(resolveOctoAccount).mockReturnValue({
        accountId: "secondary",
        enabled: true,
        configured: true,
        config: {
          apiUrl: "http://api-secondary.test",
          botToken: "tok-secondary-secret-123",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      } as any);

      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "terms",
        updated_at: "",
      });

      const result = await getExecute()("tc", {
        action: "voice-context-read",
        accountId: "secondary",
      });

      expect(result.content[0].text).not.toContain("tok-secondary-secret-123");
    });

    // -- strict accountId validation --

    it("voice-context-read with non-existent accountId returns error", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-read",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(getVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update with non-existent accountId returns error", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-update",
        content: "some terms",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-delete with non-existent accountId returns error", async () => {
      vi.mocked(listOctoAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-delete",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(deleteVoiceContext).not.toHaveBeenCalled();
    });

    // -- botToken not configured --

    it("returns error when botToken is not configured", async () => {
      const execute = getExecute();
      // After tool creation, change mock so execute sees no botToken
      vi.mocked(resolveOctoAccount).mockReturnValue({
        accountId: "no-token",
        enabled: true,
        configured: true,
        config: {
          apiUrl: "http://api.test",
          botToken: "",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      } as any);

      const result = await execute("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("botToken is not configured");
    });

    // No alias for voice-context actions

    it("voice-context-* actions do not accept aliases", async () => {
      // Action name must be exact
      const result = await getExecute()("tc", { action: "voice-read" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Unknown action");
    });
  });

  // -----------------------------------------------------------------------
  // thread-md-read
  // -----------------------------------------------------------------------
  describe("execute — thread-md-read", () => {
    it("returns THREAD.md content on success", async () => {
      vi.mocked(getThreadMd).mockResolvedValue({
        content: "# Sprint 42",
        version: 2,
        updated_at: "2026-04-13",
        updated_by: "user1",
      });
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        groupId: "g1",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.content).toBe("# Sprint 42");
      expect(data.version).toBe(2);
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error when shortId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.error).toContain("shortId");
    });

    it("returns empty content on 404 instead of throwing", async () => {
      vi.mocked(getThreadMd).mockRejectedValue(new Error("getThreadMd failed (404): not found"));
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        groupId: "g1",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.content).toBe("");
      expect(data.version).toBe(0);
    });

    it("returns error on non-404 API failure", async () => {
      vi.mocked(getThreadMd).mockRejectedValue(new Error("getThreadMd failed (500): internal"));
      const result = await getExecute()("tc", {
        action: "thread-md-read",
        groupId: "g1",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.error).toContain("Failed to read thread THREAD.md");
    });
  });

  // -----------------------------------------------------------------------
  // thread-md-update
  // -----------------------------------------------------------------------
  describe("execute — thread-md-update", () => {
    it("updates and calls broadcastThreadMdUpdate", async () => {
      vi.mocked(updateThreadMd).mockResolvedValue({ version: 3 });
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        groupId: "g1",
        shortId: "thr1",
        content: "# Updated thread",
      });
      const data = parseText(result);
      expect(data.updated).toBe(true);
      expect(data.version).toBe(3);
      expect(broadcastThreadMdUpdate).toHaveBeenCalledWith({
        accountId: "default",
        groupNo: "g1",
        shortId: "thr1",
        content: "# Updated thread",
        version: 3,
      });
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        shortId: "thr1",
        content: "# New",
      });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error when shortId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        groupId: "g1",
        content: "# New",
      });
      const data = parseText(result);
      expect(data.error).toContain("shortId");
    });

    it("returns error when content is missing", async () => {
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        groupId: "g1",
        shortId: "thr1",
      });
      const data = parseText(result);
      expect(data.error).toContain("content");
    });

    it("returns error on API failure", async () => {
      vi.mocked(updateThreadMd).mockRejectedValue(new Error("updateThreadMd failed (403): forbidden"));
      const result = await getExecute()("tc", {
        action: "thread-md-update",
        groupId: "g1",
        shortId: "thr1",
        content: "# Fail",
      });
      const data = parseText(result);
      expect(data.error).toContain("thread-md-update failed");
    });
  });

  // -----------------------------------------------------------------------
  // write-secret (user-managed external keys; internal deref)
  // -----------------------------------------------------------------------
  describe("execute — write-secret", () => {
    // The plaintext value any resolved secret yields. The whole point of this
    // feature is that THIS string never appears in a tool return value.
    const PLAINTEXT = "sk-live-SUPER-SECRET-VALUE-123";

    // Real OS temp dir used as the operator-configured jail root. Using the
    // real filesystem (not a mock) is what makes the traversal / absolute /
    // symlink rejection tests meaningful.
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "octo-secret-test-"));
      // Re-arm mocks with this run's jail root.
      setupMocks({ secretsFileRoot: root });
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const writeSecret = (args: Record<string, unknown>) =>
      getExecute()("tc", { action: "write-secret", ...args });

    it("tool schema includes the write-secret action", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      expect(tools[0].parameters.properties.action.enum).toContain("write-secret");
    });

    it("resolves the alias and writes the raw value into the jail", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({
        status: "resolved",
        value: PLAINTEXT,
        secret_id: "sec_1",
        display_name: "openai key",
      });

      const result = await writeSecret({ alias: "openai key", filePath: "secrets/.env" });
      const data = parseText(result);

      // resolve is use-time: called with the bot token + alias.
      expect(resolveSecret).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
        alias: "openai key",
      });

      // raw value written verbatim (no template) under the jail root.
      const target = join(root, "secrets/.env");
      expect(await readFile(target, "utf8")).toBe(PLAINTEXT);

      expect(data.written).toBe(true);
      // path is jail-relative — the absolute jail root is never disclosed.
      expect(data.path).toBe(join("secrets", ".env"));
      expect(data.path).not.toContain(root);
      expect(data.mode).toBe("overwrite");
      expect(data.display_name).toBe("openai key");
      // No secret-derived length field is exposed.
      expect(data).not.toHaveProperty("bytesWritten");
    });

    it("creates the secret file 0o600 (owner-only)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      await writeSecret({ alias: "k", filePath: "key.txt" });

      const st = await stat(join(root, "key.txt"));
      // Mask to permission bits. Skipped on platforms without POSIX perms.
      if (process.platform !== "win32") {
        expect(st.mode & 0o777).toBe(0o600);
      }
    });

    it("substitutes {{secret}} inside the caller template", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      await writeSecret({
        alias: "openai key",
        filePath: ".env",
        template: "OPENAI_API_KEY={{secret}}\n",
      });

      expect(await readFile(join(root, ".env"), "utf8")).toBe(
        `OPENAI_API_KEY=${PLAINTEXT}\n`,
      );
    });

    it("substitutes every {{secret}} occurrence (multi-placeholder)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      await writeSecret({
        alias: "k",
        filePath: "dup.txt",
        template: "a={{secret}};b={{secret}}",
      });

      expect(await readFile(join(root, "dup.txt"), "utf8")).toBe(
        `a=${PLAINTEXT};b=${PLAINTEXT}`,
      );
    });

    it("handles a resolved value that itself contains {{secret}}", async () => {
      // The single-pass split/join must not re-expand a literal placeholder
      // that happens to live inside the secret value.
      vi.mocked(resolveSecret).mockResolvedValue({
        status: "resolved",
        value: "val-{{secret}}-end",
      });

      await writeSecret({ alias: "k", filePath: "weird.txt", template: "X={{secret}}" });

      expect(await readFile(join(root, "weird.txt"), "utf8")).toBe("X=val-{{secret}}-end");
    });

    it("rejects a template that lacks the {{secret}} placeholder", async () => {
      const result = await writeSecret({
        alias: "k",
        filePath: ".env",
        template: "OPENAI_API_KEY=", // no placeholder → would silently write raw
      });
      expect(parseText(result).error).toContain("{{secret}} placeholder");
      // Never resolved nor wrote anything.
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("appends when mode=append", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      // seed an existing file inside the jail
      await fsWriteFile(join(root, ".env"), "EXISTING\n", "utf8");

      const result = await writeSecret({ alias: "k", filePath: ".env", mode: "append" });
      const data = parseText(result);

      expect(await readFile(join(root, ".env"), "utf8")).toBe(`EXISTING\n${PLAINTEXT}`);
      expect(data.mode).toBe("append");
    });

    it("creates the parent directory before writing", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });

      await writeSecret({ alias: "k", filePath: "nested/dir/.env" });

      expect(await readFile(join(root, "nested/dir/.env"), "utf8")).toBe(PLAINTEXT);
    });

    // 🔴 RED LINE: plaintext must never appear in the LLM-visible return value,
    // on ANY branch (templated, raw, append).
    it("NEVER returns the plaintext value — templated path (red line)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({
        status: "resolved",
        value: PLAINTEXT,
        secret_id: "sec_1",
        display_name: "openai key",
      });

      const result = await writeSecret({
        alias: "openai key",
        filePath: ".env",
        template: "OPENAI_API_KEY={{secret}}\n",
      });

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(PLAINTEXT);
      expect(result.content[0].text).not.toContain(PLAINTEXT);
      expect(JSON.stringify(result.details)).not.toContain(PLAINTEXT);
    });

    it("NEVER returns the plaintext value — raw write (red line)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const result = await writeSecret({ alias: "k", filePath: "k.txt" });
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    });

    it("NEVER returns the plaintext value — append (red line)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const result = await writeSecret({ alias: "k", filePath: "k.txt", mode: "append" });
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    });

    // -------------------------------------------------------------------
    // 🔴 PATH CONFINEMENT (P0): the file destination must stay in the jail.
    // -------------------------------------------------------------------
    it("rejects parent-directory traversal, no resolve, no write", async () => {
      const result = await writeSecret({ alias: "k", filePath: "../escape.txt" });
      expect(parseText(result).error).toMatch(/outside the allowed directory/i);
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("rejects a deep traversal that climbs past the root", async () => {
      const result = await writeSecret({ alias: "k", filePath: "a/b/../../../etc/passwd" });
      expect(parseText(result).error).toMatch(/outside the allowed directory/i);
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("rejects an absolute path outside the jail", async () => {
      const result = await writeSecret({ alias: "k", filePath: "/etc/cron.d/x" });
      expect(parseText(result).error).toMatch(/outside the allowed directory/i);
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("rejects a write through a symlinked dir that escapes the jail", async () => {
      // outside/  ← real target outside the jail
      // root/link → outside  (symlink inside the jail pointing out)
      const outside = await mkdtemp(join(tmpdir(), "octo-outside-"));
      try {
        await symlink(outside, join(root, "link"), "dir");
        const result = await writeSecret({ alias: "k", filePath: "link/pwn.txt" });
        expect(parseText(result).error).toMatch(/symlink|outside the allowed/i);
        expect(resolveSecret).not.toHaveBeenCalled();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects when the target itself is a symlink escaping the jail", async () => {
      const outside = await mkdtemp(join(tmpdir(), "octo-outside-"));
      try {
        const realTarget = join(outside, "victim.txt");
        await fsWriteFile(realTarget, "orig", "utf8");
        await symlink(realTarget, join(root, "evil.txt"), "file");
        const result = await writeSecret({ alias: "k", filePath: "evil.txt" });
        expect(parseText(result).error).toMatch(/symlink|outside the allowed/i);
        expect(resolveSecret).not.toHaveBeenCalled();
        // The out-of-jail victim must be untouched.
        expect(await readFile(realTarget, "utf8")).toBe("orig");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    // 🔴 P0 REGRESSION — dangling-symlink jail escape. The earlier guard only
    // rejected symlinks whose target ALREADY existed; a symlink pointing OUT of
    // the jail at a target that does NOT yet exist (dangling) slipped through,
    // and writeFile() then created the plaintext secret at the out-of-jail
    // target via O_CREAT. The two tests below are real PoCs against the real
    // exported handler: they build a genuine dangling symlink in the jail, call
    // write-secret, and assert (a) it is rejected, (b) resolveSecret is never
    // called, (c) NO file appears at the out-of-jail target.
    it("rejects when the target itself is a DANGLING symlink escaping the jail", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const outside = await mkdtemp(join(tmpdir(), "octo-outside-"));
      try {
        // Target does NOT exist yet (dangling). link inside jail → outside.
        const danglingTarget = join(outside, "not-yet.txt");
        await symlink(danglingTarget, join(root, "evil.txt"), "file");

        const result = await writeSecret({ alias: "k", filePath: "evil.txt" });

        expect(parseText(result).error).toMatch(/symlink|verified|outside the allowed/i);
        // Never resolved → plaintext never fetched.
        expect(resolveSecret).not.toHaveBeenCalled();
        // 🔴 The out-of-jail target must NOT have been created.
        await expect(readFile(danglingTarget, "utf8")).rejects.toThrow();
        // And no plaintext anywhere in the LLM-visible return.
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects a DANGLING symlinked DIRECTORY escaping the jail", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const outside = await mkdtemp(join(tmpdir(), "octo-outside-"));
      try {
        // An intermediate dir symlink pointing to a not-yet-existing out-of-jail
        // location. Writing "link/secret.txt" would otherwise create the file
        // (and the dir) outside the jail.
        const danglingDir = join(outside, "does-not-exist-dir");
        await symlink(danglingDir, join(root, "link"), "dir");

        const result = await writeSecret({ alias: "k", filePath: "link/secret.txt" });

        expect(parseText(result).error).toMatch(/symlink|verified|outside the allowed/i);
        expect(resolveSecret).not.toHaveBeenCalled();
        // 🔴 Nothing created at the out-of-jail location.
        await expect(readFile(join(danglingDir, "secret.txt"), "utf8")).rejects.toThrow();
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects a DANGLING symlink that points back INSIDE the jail too (unverifiable → deny)", async () => {
      // Even a dangling link whose lexical target is inside the jail cannot be
      // proven safe (realpath throws), so we deny it. Conservative but correct:
      // the caller can just write the plain path directly.
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const inJailButMissing = join(root, "later.txt");
      await symlink(inJailButMissing, join(root, "ptr.txt"), "file");

      const result = await writeSecret({ alias: "k", filePath: "ptr.txt" });

      expect(parseText(result).error).toMatch(/symlink|verified|outside the allowed/i);
      expect(resolveSecret).not.toHaveBeenCalled();
      await expect(readFile(inJailButMissing, "utf8")).rejects.toThrow();
    });

    // 🔴 P1 REGRESSION — intermediate-dir symlink TOCTOU. confineSecretPath()
    // walks the path BEFORE the parent dirs exist, so it cannot catch a symlink
    // swapped onto a parent AFTER mkdir creates it. O_NOFOLLOW only guards the
    // leaf basename, not intermediate components — the kernel still follows a
    // parent symlink. The fix re-canonicalizes the parent after mkdir and
    // re-checks containment. This PoC drives the mocked mkdir to swap the
    // freshly-created parent dir for an out-of-jail symlink in the race window
    // between mkdir and open, then asserts the write is refused and nothing
    // lands outside the jail.
    it("rejects when an intermediate dir is symlink-swapped AFTER mkdir (TOCTOU)", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const outside = await mkdtemp(join(tmpdir(), "octo-outside-"));
      const realMkdir = (await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )).mkdir;
      try {
        const subdir = join(root, "sub");
        vi.mocked(mkdir).mockImplementationOnce(async (...args: any[]) => {
          // Let the real mkdir create <root>/sub as a genuine directory…
          const ret = await (realMkdir as any)(...args);
          // …then, in the race window before open(), swap it for a symlink that
          // escapes the jail. open() via the canonical parent must refuse it.
          await rm(subdir, { recursive: true, force: true });
          await symlink(outside, subdir, "dir");
          return ret;
        });

        const result = await writeSecret({ alias: "k", filePath: "sub/secret.env" });

        expect(parseText(result).error).toMatch(/escaped the allowed root|outside the allowed/i);
        // 🔴 The out-of-jail target must NOT have been created.
        await expect(readFile(join(outside, "secret.env"), "utf8")).rejects.toThrow();
        // No plaintext anywhere in the LLM-visible return.
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects a write whose realpath'd parent escapes the root after creation", async () => {
      // A narrower unit-level check on the post-mkdir containment guard: the
      // parent resolves outside root → refuse, regardless of how it got there.
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const outside = await mkdtemp(join(tmpdir(), "octo-outside-"));
      try {
        const subdir = join(root, "deep");
        vi.mocked(mkdir).mockImplementationOnce(async () => {
          // Skip creating a real dir; install an escaping symlink as the parent.
          await symlink(outside, subdir, "dir");
          return undefined;
        });

        const result = await writeSecret({ alias: "k", filePath: "deep/k.env" });

        expect(parseText(result).error).toMatch(/escaped the allowed root/i);
        await expect(readFile(join(outside, "k.env"), "utf8")).rejects.toThrow();
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("allows the jail root itself as a relative '.' is not valid but a file at root is", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const result = await writeSecret({ alias: "k", filePath: "atroot.txt" });
      expect(parseText(result).written).toBe(true);
      expect(await readFile(join(root, "atroot.txt"), "utf8")).toBe(PLAINTEXT);
    });

    // 🔴 FAIL-CLOSED (P0): no secretsFileRoot configured → refuse every write.
    // There is deliberately NO process.cwd() fallback (that fallback was the
    // root cause of the `/`-degenerate self-lock + fail-open bugs).
    it("fails closed when secretsFileRoot is unset — no resolve, no write", async () => {
      setupMocks(); // no secretsFileRoot
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const result = await writeSecret({ alias: "k", filePath: "key.txt" });
      const data = parseText(result);
      // Explicit, operator-actionable message about the missing config.
      expect(data.error).toMatch(/not configured/i);
      expect(data.error).toMatch(/secretsFileRoot/);
      // Plaintext is never fetched and never leaks into the error.
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    });

    it("fails closed for ANY filePath when secretsFileRoot is unset (even a plain name)", async () => {
      setupMocks(); // no secretsFileRoot
      for (const filePath of [".env", "secrets/.env", "/etc/passwd", "../x"]) {
        const result = await writeSecret({ alias: "k", filePath });
        expect(parseText(result).error).toMatch(/not configured/i);
      }
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    // 🔴 REGRESSION: the old `root + sep` containment self-locked when root="/"
    // (`//` prefix matched nothing → reject everything) and a later patch made
    // root="/" fail-open. The path.relative containment has neither pathology.
    // The fail-closed default means a degenerate root="/" can never arise from
    // an unset config, but an operator could still set it explicitly, so pin the
    // behavior: a path inside "/" is contained, an absolute-elsewhere is not
    // (here everything is under "/", so it is accepted — the point is the jail
    // does NOT self-lock and does NOT crash).
    it("does not self-lock when secretsFileRoot is explicitly '/'", async () => {
      setupMocks({ secretsFileRoot: "/" });
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      const target = join(root, "explicit-root-slash.txt");
      // Use the real temp path (which is under "/") as the relative target so we
      // do not actually write to a sensitive location.
      const rel = relative("/", target);
      const result = await writeSecret({ alias: "k", filePath: rel });
      const data = parseText(result);
      expect(data.written).toBe(true);
      expect(await readFile(target, "utf8")).toBe(PLAINTEXT);
      // jail-relative path never leaks the absolute root layout.
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    });

    it("not_found → guides the user to add the key, no plaintext, no write", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "not_found" });

      const result = await writeSecret({ alias: "ghost key", filePath: ".env" });
      const data = parseText(result);

      expect(data.error).toContain("No stored secret matches");
      expect(data.error).toContain("ghost key");
      // nothing written into the jail
      await expect(readFile(join(root, ".env"), "utf8")).rejects.toThrow();
    });

    it("ambiguous → returns label-only candidates, never plaintext, no write", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({
        status: "ambiguous",
        candidates: [
          { secret_id: "a", display_name: "openai prod" },
          { secret_id: "b", display_name: "openai test" },
        ],
      });

      const result = await writeSecret({ alias: "openai", filePath: ".env" });
      const data = parseText(result);

      expect(data.written).toBe(false);
      expect(data.ambiguous).toBe(true);
      expect(data.candidates).toHaveLength(2);
      expect(data.candidates[0].display_name).toBe("openai prod");
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      await expect(readFile(join(root, ".env"), "utf8")).rejects.toThrow();
    });

    it("rate_limited → back-off hint, no body in the error, no write", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "rate_limited" });

      const result = await writeSecret({ alias: "openai key", filePath: ".env" });
      const data = parseText(result);

      expect(data.error).toMatch(/rate limited|busy/i);
      expect(data.error).toContain("openai key");
      // 🔴 The 429 path reads no body, so nothing server-controlled leaks here.
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      await expect(readFile(join(root, ".env"), "utf8")).rejects.toThrow();
    });

    it("resolve failure → actionable re-set hint, no write", async () => {
      vi.mocked(resolveSecret).mockRejectedValue(
        new Error("resolveSecret failed (500)"),
      );

      const result = await writeSecret({ alias: "k", filePath: ".env" });
      const data = parseText(result);

      expect(data.error).toContain("Could not resolve secret");
      expect(data.error).toContain("re-add");
      await expect(readFile(join(root, ".env"), "utf8")).rejects.toThrow();
    });

    it("write failure after resolve → error mentions path but not the value", async () => {
      vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
      // Make the target unwritable: create a directory where the file should go.
      await mkdir(join(root, "isdir"), { recursive: true });

      const result = await writeSecret({ alias: "k", filePath: "isdir" });
      const data = parseText(result);

      expect(data.error).toContain("failed to write");
      expect(data.error).toContain("isdir");
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    });

    it("requires alias", async () => {
      const result = await writeSecret({ filePath: ".env" });
      expect(parseText(result).error).toContain("alias is required");
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("requires filePath", async () => {
      const result = await writeSecret({ alias: "k" });
      expect(parseText(result).error).toContain("filePath is required");
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("rejects an invalid mode", async () => {
      const result = await writeSecret({ alias: "k", filePath: ".env", mode: "sideways" });
      expect(parseText(result).error).toContain("Invalid mode");
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it("resolves use-time on every call (latest value, no caching)", async () => {
      vi.mocked(resolveSecret)
        .mockResolvedValueOnce({ status: "resolved", value: "old-value" })
        .mockResolvedValueOnce({ status: "resolved", value: "rotated-value" });

      await writeSecret({ alias: "k", filePath: ".env" });
      await writeSecret({ alias: "k", filePath: ".env" });

      expect(resolveSecret).toHaveBeenCalledTimes(2);
      // overwrite mode → file ends up with the latest value.
      expect(await readFile(join(root, ".env"), "utf8")).toBe("rotated-value");
    });

    // -----------------------------------------------------------------------
    // Jail root DEFAULT = agent workspace (YUJ-3947)
    //
    // When no explicit secretsFileRoot is configured, the jail root falls back
    // to the agent's workspace (cfg.agents.list[].workspace matched by
    // agentAccountId, else cfg.agents.defaults.workspace). This removes the
    // "operator must hand-configure secretsFileRoot" step from PR#92 WITHOUT
    // weakening the security model: if no usable (non-root) workspace resolves,
    // the write still FAILS CLOSED — there is NO process.cwd() fallback.
    // -----------------------------------------------------------------------
    describe("jail root default = agent workspace", () => {
      // Build an execute() bound to a cfg with agents config + an agentAccountId,
      // so the workspace-default resolution path is exercised. setupMocks (run in
      // the parent beforeEach) controls the account-level secretsFileRoot.
      const executeWithAgents = (
        agents: unknown,
        agentAccountId: string | undefined,
        agentId?: string,
      ) => {
        const cfg = { ...mockCfg, agents } as any;
        const tools = createOctoManagementTools({ cfg, agentAccountId, agentId });
        expect(tools).toHaveLength(1);
        return (args: Record<string, unknown>) =>
          (tools[0].execute as any)("tc", { action: "write-secret", ...args });
      };

      it("jails to the matched agent's workspace when secretsFileRoot is unset", async () => {
        setupMocks(); // no secretsFileRoot → falls back to workspace
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(
          { defaults: { workspace: "/nope" }, list: [{ id: "bot-A", workspace: root }] },
          "bot-A",
        );

        const result = await exec({ alias: "k", filePath: "in-jail.env" });
        const data = parseText(result);

        expect(data.written).toBe(true);
        expect(await readFile(join(root, "in-jail.env"), "utf8")).toBe(PLAINTEXT);
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      });

      it("rejects an out-of-jail path under the agent-workspace default", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(
          { list: [{ id: "bot-A", workspace: root }] },
          "bot-A",
        );

        const result = await exec({ alias: "k", filePath: "../escape.env" });
        const data = parseText(result);

        expect(data.error).toMatch(/outside the allowed|permitted root/i);
        // Plaintext never fetched / leaked on a confinement reject.
        expect(resolveSecret).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      });

      it("falls back to defaults.workspace when the agent has no own workspace", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(
          { defaults: { workspace: root }, list: [{ id: "bot-A" }] },
          "bot-A",
        );

        const result = await exec({ alias: "k", filePath: "via-defaults.env" });
        const data = parseText(result);

        expect(data.written).toBe(true);
        expect(await readFile(join(root, "via-defaults.env"), "utf8")).toBe(PLAINTEXT);
      });

      // 🔴 P0 (Jerry-Xin + yujiawei) — NON-DEFAULT agent jail = per-agent
      // SUBDIRECTORY of defaults.workspace, NEVER the bare shared parent. Here
      // bot-A is not the default agent (someone-else is), so the platform's
      // canonical resolveAgentWorkspaceDir derives <defaults.workspace>/<agentId>.
      // The previous hand-rolled resolver wrongly jailed every non-default agent
      // to the WHOLE defaults.workspace, letting one agent write into another's
      // tree. Assert the secret lands under the per-agent subdir, not the parent.
      it("jails a non-default agent to defaults.workspace/<agentId> (per-agent subdir)", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(
          { defaults: { workspace: root }, list: [{ id: "someone-else", workspace: "/x" }] },
          undefined,
          "bot-A", // non-default agent (default is someone-else)
        );

        const result = await exec({ alias: "k", filePath: "no-match.env" });
        expect(parseText(result).written).toBe(true);
        // Under the per-agent subdir…
        expect(await readFile(join(root, "bot-a", "no-match.env"), "utf8")).toBe(PLAINTEXT);
        // …NOT the bare shared parent.
        await expect(
          readFile(join(root, "no-match.env"), "utf8"),
        ).rejects.toThrow();
      });

      // 🔴 P0 (Jerry-Xin + yujiawei) — a non-default agent must NOT be able to
      // climb out of its per-agent subdir into a SIBLING agent's directory and
      // write the owner's plaintext there. This is the concrete cross-agent
      // secret-write escape the bare-defaults jail allowed: a `worker` writing
      // `main/.env`. With the per-agent subdir jail, `../main/.env` resolves
      // outside the jail and is refused before any plaintext is fetched.
      it("rejects a non-default agent writing into a sibling agent's dir (worker→main/.env)", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        // Pre-create a sibling "main" dir so a successful escape would actually
        // land a file there — making the assertion that nothing escaped real.
        await mkdir(join(root, "main"), { recursive: true });
        const exec = executeWithAgents(
          {
            defaults: { workspace: root },
            list: [
              { id: "main", default: true },
              { id: "worker" },
            ],
          },
          undefined,
          "worker", // non-default agent → jailed to <root>/worker
        );

        const result = await exec({ alias: "k", filePath: "../main/.env" });
        expect(parseText(result).error).toMatch(/outside the allowed|permitted root/i);
        // Plaintext never fetched on a confinement reject; nothing written to main/.
        expect(resolveSecret).not.toHaveBeenCalled();
        await expect(readFile(join(root, "main", ".env"), "utf8")).rejects.toThrow();
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      });

      it("explicit secretsFileRoot still wins over the agent-workspace default", async () => {
        // Operator wants a NARROWER jail than the workspace: secretsFileRoot must
        // take precedence. Point the workspace at a sibling temp dir and assert
        // the file lands under secretsFileRoot (root), not the workspace.
        const otherWorkspace = await mkdtemp(join(tmpdir(), "octo-ws-"));
        try {
          setupMocks({ secretsFileRoot: root });
          vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
          const exec = executeWithAgents(
            { list: [{ id: "bot-A", workspace: otherWorkspace }] },
            "bot-A",
          );

          const result = await exec({ alias: "k", filePath: "explicit.env" });
          expect(parseText(result).written).toBe(true);
          // Written under the explicit root…
          expect(await readFile(join(root, "explicit.env"), "utf8")).toBe(PLAINTEXT);
          // …NOT under the workspace.
          await expect(
            readFile(join(otherWorkspace, "explicit.env"), "utf8"),
          ).rejects.toThrow();
        } finally {
          await rm(otherWorkspace, { recursive: true, force: true });
        }
      });

      it("fails closed when neither secretsFileRoot nor any workspace is set", async () => {
        setupMocks(); // no secretsFileRoot
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents({ list: [{ id: "bot-A" }] }, "bot-A");

        const result = await exec({ alias: "k", filePath: "key.env" });
        const data = parseText(result);

        expect(data.error).toMatch(/not configured/i);
        expect(resolveSecret).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      });

      it("fails closed when cfg has no agents block at all", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(undefined, "bot-A");

        const result = await exec({ alias: "k", filePath: "key.env" });
        expect(parseText(result).error).toMatch(/not configured/i);
        expect(resolveSecret).not.toHaveBeenCalled();
      });

      it("fails closed when defaults.workspace resolves to '/' (degenerate root)", async () => {
        // A defaults.workspace mistakenly set to "/" must NOT become a root-wide
        // secret jail — treat it as no usable default and fail closed.
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents({ defaults: { workspace: "/" } }, "bot-A");

        const result = await exec({ alias: "k", filePath: "key.env" });
        expect(parseText(result).error).toMatch(/not configured/i);
        expect(resolveSecret).not.toHaveBeenCalled();
      });

      it("fails closed when the agent workspace is an empty/whitespace string", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(
          { defaults: { workspace: "   " }, list: [{ id: "bot-A", workspace: "" }] },
          "bot-A",
        );

        const result = await exec({ alias: "k", filePath: "key.env" });
        expect(parseText(result).error).toMatch(/not configured/i);
        expect(resolveSecret).not.toHaveBeenCalled();
      });

      // 🔴 BLOCKING REGRESSION (Jerry-Xin) — symlink-to-`/` fail-open.
      // The old guard checked the LEXICAL form (`resolvePath(workspace) === sep`),
      // so a workspace configured as a symlink whose REAL target is "/" slipped
      // past it (the lexical path is the link, ≠ "/") and only degenerated into a
      // root-wide jail later inside confineSecretPath's realpath(). The fix moves
      // the degenerate-root check to AFTER realpath canonicalization, so a
      // workspace that resolves to "/" now fails closed here.
      it("fails closed when the agent workspace is a symlink to '/' (realpath-after-canon)", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const linkToRoot = join(root, "ws-root-link");
        await symlink("/", linkToRoot, "dir");
        // Sanity: lexically the workspace is NOT "/", so the old guard would pass it.
        expect(linkToRoot).not.toBe("/");

        const exec = executeWithAgents(
          { list: [{ id: "bot-A", workspace: linkToRoot }] },
          "bot-A",
        );

        const result = await exec({ alias: "k", filePath: "key.env" });
        expect(parseText(result).error).toMatch(/not configured/i);
        // Plaintext never fetched / leaked on the fail-closed path.
        expect(resolveSecret).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      });

      // 🔴 BLOCKING (Jerry-Xin) — Windows drive root must fail closed too. The old
      // `=== sep` compare never matched "C:\\" (resolvePath("C:\\") !== "/"), so a
      // drive-root workspace would have degenerated into a root-wide jail. The
      // path.parse(p).root === p check covers POSIX and Windows roots alike.
      // Drive roots only exist on win32, so this assertion is platform-gated.
      it("fails closed when the agent workspace is a Windows drive root", async () => {
        if (process.platform !== "win32") return; // drive roots are win32-only
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(
          { list: [{ id: "bot-A", workspace: "C:\\" }] },
          "bot-A",
        );

        const result = await exec({ alias: "k", filePath: "key.env" });
        expect(parseText(result).error).toMatch(/not configured/i);
        expect(resolveSecret).not.toHaveBeenCalled();
      });

      // 必修2 — match key namespace. The workspace is indexed by OpenClaw AGENT
      // id, not the channel/Octo account id. When the two differ (e.g. agent
      // `main` ↔ octo account `default`), keying on the account id silently misses
      // the per-agent workspace and falls back to defaults. Assert that passing a
      // distinct agentId hits the per-agent workspace even though agentAccountId
      // points at a different entry.
      it("matches the per-agent workspace by agentId when account id ≠ agent id", async () => {
        setupMocks(); // no secretsFileRoot → workspace default
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(
          {
            defaults: { workspace: "/nope" },
            // The agent we want is keyed by agent id "main"; the octo account id
            // is the unrelated "default".
            list: [{ id: "main", workspace: root }],
          },
          "default", // agentAccountId (octo account) — does NOT match list[].id
          "main", // agentId (OpenClaw agent) — DOES match
        );

        const result = await exec({ alias: "k", filePath: "by-agent-id.env" });
        const data = parseText(result);

        expect(data.written).toBe(true);
        expect(await readFile(join(root, "by-agent-id.env"), "utf8")).toBe(PLAINTEXT);
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      });

      // 必修2 — agentId takes precedence over agentAccountId when both match
      // different entries. The correct (per-agent-id) workspace must win.
      it("prefers agentId over agentAccountId when both match different entries", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const wrongWorkspace = await mkdtemp(join(tmpdir(), "octo-ws-wrong-"));
        try {
          const exec = executeWithAgents(
            {
              list: [
                { id: "main", workspace: root }, // matched by agentId
                { id: "default", workspace: wrongWorkspace }, // matched by accountId
              ],
            },
            "default", // agentAccountId
            "main", // agentId — should win
          );

          const result = await exec({ alias: "k", filePath: "pref.env" });
          expect(parseText(result).written).toBe(true);
          // Written under the agentId-matched workspace…
          expect(await readFile(join(root, "pref.env"), "utf8")).toBe(PLAINTEXT);
          // …NOT under the accountId-matched one.
          await expect(
            readFile(join(wrongWorkspace, "pref.env"), "utf8"),
          ).rejects.toThrow();
        } finally {
          await rm(wrongWorkspace, { recursive: true, force: true });
        }
      });

      // 必修2 — agent id matching is namespace-normalized (lower/slug), matching
      // the platform's normalizeAgentId. A config entry id with different casing
      // must still match the runtime agent id.
      it("matches the agent workspace case-insensitively (normalizeAgentId)", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const exec = executeWithAgents(
          { list: [{ id: "Bot-A", workspace: root }] },
          undefined,
          "bot-a", // differs only in casing
        );

        const result = await exec({ alias: "k", filePath: "case.env" });
        expect(parseText(result).written).toBe(true);
        expect(await readFile(join(root, "case.env"), "utf8")).toBe(PLAINTEXT);
      });

      // 必修3 — `~` expansion. A workspace configured as "~/<subdir>" must expand
      // to $HOME, matching the platform's canonical resolveAgentWorkspaceDir,
      // rather than being treated as a literal "./~" segment.
      it("expands a leading ~ in the workspace to the home directory", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        // Carve a real workspace under HOME so realpath canonicalization succeeds.
        const home = homedir();
        const wsName = `octo-tilde-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const wsAbs = join(home, wsName);
        await mkdir(wsAbs, { recursive: true });
        try {
          const exec = executeWithAgents(
            { list: [{ id: "bot-A", workspace: `~/${wsName}` }] },
            "bot-A",
          );

          const result = await exec({ alias: "k", filePath: "tilde.env" });
          expect(parseText(result).written).toBe(true);
          expect(await readFile(join(wsAbs, "tilde.env"), "utf8")).toBe(PLAINTEXT);
        } finally {
          await rm(wsAbs, { recursive: true, force: true });
        }
      });

      // 必修3 — $VAR / ${VAR} expansion. A workspace parameterized by an env var
      // must expand before the path is used as the jail root.
      it("expands $VAR / ${VAR} in the workspace path", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const prev = process.env.OCTO_TEST_WS;
        process.env.OCTO_TEST_WS = root;
        try {
          const exec = executeWithAgents(
            { list: [{ id: "bot-A", workspace: "${OCTO_TEST_WS}/sub" }] },
            "bot-A",
          );

          const result = await exec({ alias: "k", filePath: "envvar.env" });
          expect(parseText(result).written).toBe(true);
          expect(await readFile(join(root, "sub", "envvar.env"), "utf8")).toBe(PLAINTEXT);
        } finally {
          if (prev === undefined) delete process.env.OCTO_TEST_WS;
          else process.env.OCTO_TEST_WS = prev;
        }
      });

      // 🔴 必修2 / P1-A (lml2468) — symlink-ANCESTOR first-write must NOT be
      // false-rejected. When the jail root sits under a symlinked ancestor AND
      // the workspace dir does not exist yet (the common first-write case), the
      // old code stored the root in its LEXICAL form but compared it post-mkdir
      // against realpath(dir). The two diverged through the symlink and the write
      // was wrongly refused as "escaped the allowed root after creation". The fix
      // canonicalizes BOTH the resolved workspace (resolveAgentWorkspaceRoot) and
      // the jail root (confineSecretPath) through their nearest existing ancestor,
      // so every comparison is symlink-free.
      //
      // lml2468 asked for coverage of three real-world ancestor-symlink shapes,
      // not just one. Each case builds a genuine symlinked-ancestor root whose
      // workspace leaf does not exist yet, then asserts the FIRST write succeeds
      // and the file materializes at the REAL (symlink-resolved) target.
      const symlinkAncestorCases: {
        label: string;
        build: () => Promise<{ workspace: string; realTarget: string; cleanup: () => Promise<void> }>;
      }[] = [
        {
          // macOS-style: an intermediate path component is a symlink to its real
          // dir (e.g. /tmp → /private/tmp). Workspace = <link>/ws.
          label: "intermediate symlink (macOS /tmp→/private/tmp shape)",
          build: async () => {
            const realDir = await mkdtemp(join(tmpdir(), "octo-real-tmp-"));
            const linkDir = join(tmpdir(), `octo-link-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            await symlink(realDir, linkDir, "dir");
            return {
              workspace: join(linkDir, "ws"),
              realTarget: join(realDir, "ws"),
              cleanup: async () => {
                await rm(linkDir, { force: true });
                await rm(realDir, { recursive: true, force: true });
              },
            };
          },
        },
        {
          // Symlinked HOME shape: the home-like ancestor itself is a symlink and
          // the workspace is nested several levels below it.
          label: "symlinked HOME ancestor",
          build: async () => {
            const realHome = await mkdtemp(join(tmpdir(), "octo-real-home-"));
            await mkdir(join(realHome, "agents"), { recursive: true });
            const linkHome = join(tmpdir(), `octo-link-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            await symlink(realHome, linkHome, "dir");
            return {
              workspace: join(linkHome, "agents", "ws", "secrets"),
              realTarget: join(realHome, "agents", "ws", "secrets"),
              cleanup: async () => {
                await rm(linkHome, { force: true });
                await rm(realHome, { recursive: true, force: true });
              },
            };
          },
        },
        {
          // Container bind-mount shape: a chain of symlinks (link→link→realdir),
          // as a bind-mounted path indirected through more than one link can
          // present. Workspace = <top-link>/data/ws.
          label: "bind-mount-style symlink chain",
          build: async () => {
            const realDir = await mkdtemp(join(tmpdir(), "octo-real-bm-"));
            const midLink = join(tmpdir(), `octo-bm-mid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            await symlink(realDir, midLink, "dir");
            const topLink = join(tmpdir(), `octo-bm-top-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            await symlink(midLink, topLink, "dir");
            return {
              workspace: join(topLink, "data", "ws"),
              realTarget: join(realDir, "data", "ws"),
              cleanup: async () => {
                await rm(topLink, { force: true });
                await rm(midLink, { force: true });
                await rm(realDir, { recursive: true, force: true });
              },
            };
          },
        },
      ];

      for (const tc of symlinkAncestorCases) {
        it(`does not false-reject a first write through a ${tc.label}`, async () => {
          setupMocks();
          vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
          const { workspace, realTarget, cleanup } = await tc.build();
          try {
            const exec = executeWithAgents(
              { list: [{ id: "bot-A", workspace }] },
              "bot-A",
            );

            const result = await exec({ alias: "k", filePath: "first.env" });
            expect(parseText(result).written).toBe(true);
            // File lands at the REAL (symlink-resolved) target, first write.
            expect(await readFile(join(realTarget, "first.env"), "utf8")).toBe(PLAINTEXT);
            expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
          } finally {
            await cleanup();
          }
        });
      }

      // 🔴 P1-B (Yu CR) — an UNDEFINED env var in the workspace path must FAIL
      // CLOSED, not anchor the jail to process.cwd(). A literal, unexpanded
      // `${UNDEF}` fed to path.resolve() silently roots the relative remainder at
      // the current working directory, which would sail past both filesystem-root
      // degeneracy guards and rebuild exactly the cwd-anchored jail this PR's
      // fail-closed guarantee exists to prevent. Assert: refusal + no resolve()
      // call + nothing written under cwd.
      it("fails closed when the workspace references an UNDEFINED env var (no cwd anchor)", async () => {
        setupMocks();
        vi.mocked(resolveSecret).mockResolvedValue({ status: "resolved", value: PLAINTEXT });
        const varName = `OCTO_UNSET_${Date.now()}`;
        // Ensure the var is genuinely undefined.
        delete process.env[varName];
        const exec = executeWithAgents(
          { list: [{ id: "bot-A", workspace: `\${${varName}}/octo-secrets` }] },
          "bot-A",
        );

        const result = await exec({ alias: "k", filePath: "leak.env" });
        expect(parseText(result).error).toMatch(/not configured/i);
        // Never fetched the plaintext on the fail-closed path…
        expect(resolveSecret).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
        // …and crucially nothing was written under the literal "${UNDEF}" dir
        // that a cwd-anchored resolve would have created.
        await expect(
          readFile(join(process.cwd(), `\${${varName}}`, "octo-secrets", "leak.env"), "utf8"),
        ).rejects.toThrow();
      });
    });
  });

  // -----------------------------------------------------------------------
  // resolve action (name → target candidates)
  // -----------------------------------------------------------------------
  describe("resolve action", () => {
    beforeEach(() => {
      _clearResolveCache();
      vi.mocked(getKnownGroupIds).mockReturnValue(new Set());
    });

    it("enum contains 'resolve'", () => {
      const tools = createOctoManagementTools({ cfg: mockCfg });
      expect(tools[0].parameters.properties.action.enum).toContain("resolve");
      // resolve-only params are present
      expect(tools[0].parameters.properties.kind).toBeDefined();
      expect(tools[0].parameters.properties.limit).toBeDefined();
    });

    it("requires a non-empty name", async () => {
      const execute = getExecute();
      const res = await execute("id", { action: "resolve" });
      const data = res.details as any;
      expect(data.error).toContain("name is required");
      expect(resolveTargetsByName).not.toHaveBeenCalled();
    });

    it("rejects an invalid kind", async () => {
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "X", kind: "bogus" });
      const data = res.details as any;
      expect(data.error).toContain("Invalid kind");
      expect(resolveTargetsByName).not.toHaveBeenCalled();
    });

    it("0 candidates → not-found result with fuzzy suggestions", async () => {
      vi.mocked(getKnownGroupIds).mockReturnValue(new Set(["Sales Team", "Random"]));
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [],
        total: 0,
        truncated: false,
      });
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "sales" });
      const data = res.details as any;
      expect(data.resolved).toBeNull();
      expect(data.candidates).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.error).toContain('No target named "sales" found');
      expect(data.suggestions).toContain("Sales Team");
      expect(data.suggestions).not.toContain("Random");
    });

    it("0 candidates with no matching known names → empty suggestions", async () => {
      vi.mocked(getKnownGroupIds).mockReturnValue(new Set(["grp123"]));
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [],
        total: 0,
        truncated: false,
      });
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "nonexistent" });
      const data = res.details as any;
      expect(data.suggestions).toEqual([]);
    });

    it("exactly 1 candidate → resolved echoes kind, does not send", async () => {
      const candidate: any = {
        kind: "group",
        channelId: "grp1",
        channelType: 2,
        name: "Sales",
        groupNo: "grp1",
      };
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [candidate],
        total: 1,
        truncated: false,
      });
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "Sales" });
      const data = res.details as any;
      expect(data.resolved).toEqual(candidate);
      expect(data.resolved.kind).toBe("group");
      // No candidates list on the single-resolve shape; nothing auto-sent.
      expect(data.candidates).toBeUndefined();
    });

    // 🔴 BLOCKER: a single RETURNED candidate that is NOT the whole match set
    // (total>1 and/or truncated) must NOT auto-resolve — otherwise a limit:1
    // request over 5 matches would silently treat a partial result as a
    // confident pick. It must fall through to the candidates branch so the agent
    // asks the user.
    it("1 returned but total>1 → returns candidates, NOT resolved (no silent send)", async () => {
      const candidate: any = {
        kind: "group",
        channelId: "grp1",
        channelType: 2,
        name: "Sales",
        groupNo: "grp1",
      };
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [candidate],
        total: 5,
        truncated: false,
      });
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "Sales", limit: 1 });
      const data = res.details as any;
      // Must NOT auto-resolve a truncated/partial result.
      expect(data.resolved).toBeUndefined();
      expect(data.candidates).toHaveLength(1);
      expect(data.total).toBe(5);
    });

    it("1 returned but truncated:true → returns candidates, NOT resolved", async () => {
      const candidate: any = {
        kind: "group",
        channelId: "grp1",
        channelType: 2,
        name: "Sales",
        groupNo: "grp1",
      };
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [candidate],
        total: 1,
        truncated: true,
      });
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "Sales" });
      const data = res.details as any;
      expect(data.resolved).toBeUndefined();
      expect(data.candidates).toHaveLength(1);
      expect(data.truncated).toBe(true);
    });

    it("multiple candidates (same-name group + thread) → returns candidates, no send", async () => {
      const candidates: any[] = [
        { kind: "group", channelId: "grp1", channelType: 2, name: "Ops", groupNo: "grp1" },
        {
          kind: "thread",
          channelId: "grp1____tp01",
          channelType: 5,
          name: "Ops",
          groupNo: "grp1",
          shortId: "tp01",
          parentName: "Parent",
        },
      ];
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates,
        total: 2,
        truncated: false,
      });
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "Ops" });
      const data = res.details as any;
      expect(data.candidates).toHaveLength(2);
      expect(data.total).toBe(2);
      expect(data.resolved).toBeUndefined();
    });

    it("multiple same-name threads → returns candidates", async () => {
      const candidates: any[] = [
        { kind: "thread", channelId: "grp1____a", channelType: 5, name: "Bugs", groupNo: "grp1", shortId: "a", parentName: "P1" },
        { kind: "thread", channelId: "grp2____b", channelType: 5, name: "Bugs", groupNo: "grp2", shortId: "b", parentName: "P2" },
      ];
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates,
        total: 2,
        truncated: false,
      });
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "Bugs" });
      const data = res.details as any;
      expect(data.candidates).toHaveLength(2);
    });

    it("truncated:true is passed through", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [
          { kind: "group", channelId: "g1", channelType: 2, name: "A", groupNo: "g1" } as any,
          { kind: "group", channelId: "g2", channelType: 2, name: "A", groupNo: "g2" } as any,
        ],
        total: 2,
        truncated: true,
      });
      const execute = getExecute();
      const res = await execute("id", { action: "resolve", name: "A" });
      const data = res.details as any;
      expect(data.truncated).toBe(true);
    });

    it("forwards kind and limit into the request", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [],
        total: 0,
        truncated: false,
      });
      const execute = getExecute();
      await execute("id", { action: "resolve", name: "X", kind: "thread", limit: 5 });
      expect(resolveTargetsByName).toHaveBeenCalledWith(
        expect.objectContaining({ name: "X", kind: "thread", limit: 5 }),
      );
    });

    // MINOR: an invalid limit (<=0, NaN, non-integer) must be dropped so the
    // backend default applies — never forwarded as 0 / negative into the query.
    it("does not forward an invalid limit (<=0 / NaN / non-integer)", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [],
        total: 0,
        truncated: false,
      });
      const execute = getExecute();

      for (const bad of [0, -3, Number.NaN]) {
        vi.mocked(resolveTargetsByName).mockClear();
        _clearResolveCache();
        await execute("id", { action: "resolve", name: "X", limit: bad });
        const call = vi.mocked(resolveTargetsByName).mock.calls[0][0] as any;
        expect(call.limit).toBeUndefined();
      }

      // A non-integer is floored only when it stays positive; <1 fractional drops.
      vi.mocked(resolveTargetsByName).mockClear();
      _clearResolveCache();
      await execute("id", { action: "resolve", name: "X", limit: 0.5 });
      expect((vi.mocked(resolveTargetsByName).mock.calls[0][0] as any).limit).toBeUndefined();
    });

    it("floors a positive non-integer limit and forwards it", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [],
        total: 0,
        truncated: false,
      });
      const execute = getExecute();
      await execute("id", { action: "resolve", name: "X", limit: 7.9 });
      expect(resolveTargetsByName).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 7 }),
      );
    });

    // MAJOR: a 0-candidate (not-found) result must NOT be cached, so a target
    // freshly created/renamed seconds later is not masked by a stale miss. A
    // second resolve after an initial 0-result must hit fetch again.
    it("does not cache a 0-candidate result — second resolve refetches", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [],
        total: 0,
        truncated: false,
      });
      const execute = getExecute();
      await execute("id", { action: "resolve", name: "Fresh" });
      await execute("id", { action: "resolve", name: "Fresh" });
      expect(resolveTargetsByName).toHaveBeenCalledTimes(2);
    });

    it("caches a POSITIVE result — second identical resolve refetches only once", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [
          { kind: "group", channelId: "g1", channelType: 2, name: "Hit", groupNo: "g1" } as any,
        ],
        total: 1,
        truncated: false,
      });
      const execute = getExecute();
      await execute("id", { action: "resolve", name: "Hit" });
      await execute("id", { action: "resolve", name: "Hit" });
      expect(resolveTargetsByName).toHaveBeenCalledTimes(1);
    });

    it("caches within TTL — second identical resolve does not refetch", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [
          { kind: "group", channelId: "g1", channelType: 2, name: "Dup", groupNo: "g1" } as any,
        ],
        total: 1,
        truncated: false,
      });
      const execute = getExecute();
      await execute("id", { action: "resolve", name: "Dup" });
      await execute("id", { action: "resolve", name: "Dup" });
      expect(resolveTargetsByName).toHaveBeenCalledTimes(1);
    });

    it("different kind is a distinct cache key", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [
          { kind: "group", channelId: "g1", channelType: 2, name: "Dup", groupNo: "g1" } as any,
        ],
        total: 1,
        truncated: false,
      });
      const execute = getExecute();
      await execute("id", { action: "resolve", name: "Dup", kind: "group" });
      await execute("id", { action: "resolve", name: "Dup", kind: "thread" });
      expect(resolveTargetsByName).toHaveBeenCalledTimes(2);
    });

    it("cache clear hook resets the cache", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [
          { kind: "group", channelId: "g1", channelType: 2, name: "Dup", groupNo: "g1" } as any,
        ],
        total: 1,
        truncated: false,
      });
      const execute = getExecute();
      await execute("id", { action: "resolve", name: "Dup" });
      _clearResolveCache();
      await execute("id", { action: "resolve", name: "Dup" });
      expect(resolveTargetsByName).toHaveBeenCalledTimes(2);
    });

    // A limit:1 lookup returns a bounded page; a later wider (no-limit) lookup
    // for the same name must NOT be served from that narrow cache entry — the
    // limit is part of the cache key.
    it("limit is part of the cache key — limit:1 then no-limit refetches", async () => {
      vi.mocked(resolveTargetsByName).mockResolvedValue({
        candidates: [
          { kind: "group", channelId: "g1", channelType: 2, name: "Dup", groupNo: "g1" } as any,
        ],
        total: 1,
        truncated: false,
      });
      const execute = getExecute();
      await execute("id", { action: "resolve", name: "Dup", limit: 1 });
      await execute("id", { action: "resolve", name: "Dup" });
      expect(resolveTargetsByName).toHaveBeenCalledTimes(2);
    });

    // The positive-result cache only holds for RESOLVE_CACHE_TTL_MS (30s); once
    // it expires the next identical resolve must hit fetch again.
    it("cache expires after TTL — identical resolve refetches", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(resolveTargetsByName).mockResolvedValue({
          candidates: [
            { kind: "group", channelId: "g1", channelType: 2, name: "Dup", groupNo: "g1" } as any,
          ],
          total: 1,
          truncated: false,
        });
        const execute = getExecute();
        await execute("id", { action: "resolve", name: "Dup" });
        // Within TTL → served from cache, no refetch.
        vi.advanceTimersByTime(29_999);
        await execute("id", { action: "resolve", name: "Dup" });
        expect(resolveTargetsByName).toHaveBeenCalledTimes(1);
        // Past TTL → entry expired, refetch.
        vi.advanceTimersByTime(2);
        await execute("id", { action: "resolve", name: "Dup" });
        expect(resolveTargetsByName).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
