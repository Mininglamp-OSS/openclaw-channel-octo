import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

// Exercise the production registration body, without loading a second copy of
// the channel through the host's filesystem loader.
vi.mock("openclaw/plugin-sdk/channel-entry-contract", () => ({
  defineBundledChannelEntry: (entry: unknown) => entry,
}));

function registeredHooks() {
  const hooks = new Map<string, Array<(event: any, ctx: any) => any>>();
  (plugin as unknown as { registerFull: (api: any) => void }).registerFull({
    registrationMode: "full", config: {}, logger: { warn: vi.fn(), info: vi.fn() },
    registerTool: vi.fn(), registerChannel: vi.fn(), runtime: {},
    on: (name: string, handler: any) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
  });
  return async (toolName: string, sessionKey?: string) => {
    const results = [];
    for (const handler of hooks.get("before_tool_call") ?? []) {
      results.push(await handler({ toolName, toolCallId: "call", params: {} }, { sessionKey, runId: "run" }));
    }
    return results.find(result => result?.block);
  };
}

describe("document task tool policy through plugin registration", () => {
  it.each(["doctask:doc:thread", "doctask:ppt:doc:thread"])("blocks spawn and yield without a progress tracker (%s)", async scope => {
    const beforeTool = registeredHooks();
    for (const tool of ["sessions_spawn", "sessions_yield"]) {
      expect(await beforeTool(tool, `agent:one:octo:acct:${scope}`)).toMatchObject({
        block: true, blockReason: expect.stringContaining("current run"),
      });
    }
    expect(await beforeTool("exec", `agent:one:octo:acct:${scope}`)).toBeUndefined();
  });

  it.each(["agent:one:octo:acct:group:thread", "agent:one:octo:acct:dm:u_doctask_fan", "agent:one:bot-task:task", undefined])("leaves other sessions unchanged (%s)", async sessionKey => {
    const beforeTool = registeredHooks();
    expect(await beforeTool("sessions_spawn", sessionKey)).toBeUndefined();
    expect(await beforeTool("sessions_yield", sessionKey)).toBeUndefined();
  });
});
