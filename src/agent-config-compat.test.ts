import { describe, expect, it } from "vitest";
import { findAgentConfig } from "./agent-config-compat.js";

describe("per-agent config across OpenClaw versions", () => {
  it.each([
    { list: [{ id: "Bot-A", workspace: "/agent-workspace", reasoningDefault: "stream" }] },
    { entries: { "Bot-A": { workspace: "/agent-workspace", reasoningDefault: "stream" } } },
  ])("reads the agent's own workspace and reasoning settings", agents => {
    expect(findAgentConfig(agents, "bot-a")).toMatchObject({ workspace: "/agent-workspace", reasoningDefault: "stream" });
    expect(findAgentConfig(agents, "other")).toBeUndefined();
  });
  it("honors canonical entries rather than stale legacy list values", () => {
    expect(findAgentConfig({ entries: {}, list: [{ id: "main", workspace: "/stale" }] }, "main")).toBeUndefined();
  });
});
