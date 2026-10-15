import { describe, expect, it, vi } from "vitest";
import { resolveImDispatchTimeoutMs } from "./im-dispatch-timeout.js";

const MAX = 2 ** 31 - 1;
describe("ordinary IM host timeout compatibility (#269)", () => {
  it.each([600_000, 172_800_000])("follows the running host's default %i, rather than a copied default", (budget) => {
    const cfg = {};
    const resolve = vi.fn(() => budget);
    expect(resolveImDispatchTimeoutMs(cfg, undefined, { agent: { resolveAgentTimeoutMs: resolve } })).toBe(budget + 60_000);
    expect(resolve).toHaveBeenCalledWith({ cfg });
  });
  it.each([0, MAX, Number.MAX_SAFE_INTEGER])("keeps unlimited/large host budgets timer safe (%i)", (budget) => {
    expect(resolveImDispatchTimeoutMs({}, undefined, { agent: { resolveAgentTimeoutMs: () => budget } })).toBe(MAX);
  });
  it("explicit queue override takes precedence without consulting the host", () => {
    const resolve = vi.fn(() => { throw new Error("must not call"); });
    expect(resolveImDispatchTimeoutMs({}, 1000, { agent: { resolveAgentTimeoutMs: resolve } })).toBe(1000);
    expect(resolve).not.toHaveBeenCalled();
    expect(resolveImDispatchTimeoutMs({}, Number.MAX_SAFE_INTEGER, {})).toBe(MAX);
  });
  it.each([undefined, 0, -1, NaN, Infinity, "1000"])("invalid override %s falls through to the host", (value) => {
    expect(resolveImDispatchTimeoutMs({}, value, { agent: { resolveAgentTimeoutMs: () => 50_000 } })).toBe(110_000);
  });
  it.each([{}, { agent: { resolveAgentTimeoutMs: () => { throw new Error("old host"); } } },
    { agent: { resolveAgentTimeoutMs: () => NaN } }])("older/custom hosts use an explicit agent budget, never a guessed default", (host) => {
    expect(resolveImDispatchTimeoutMs({ agents: { defaults: { timeoutSeconds: 1800 } } }, undefined, host)).toBe(1_860_000);
    const warn = vi.fn();
    expect(resolveImDispatchTimeoutMs({}, undefined, host, warn)).toBe(MAX);
    expect(warn).toHaveBeenCalledOnce();
    expect(resolveImDispatchTimeoutMs({ agents: { defaults: { timeoutSeconds: 0 } } }, undefined, host)).toBe(MAX);
  });
});
