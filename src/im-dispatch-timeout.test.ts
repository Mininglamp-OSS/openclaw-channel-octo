import { describe, expect, it, vi } from "vitest";
import { resolveImDispatchTimeoutMs, UNKNOWN_HOST_QUEUE_WAIT_MS, UNLIMITED_HOST_QUEUE_WAIT_MS } from "./im-dispatch-timeout.js";

const MAX = 2 ** 31 - 1;
describe("ordinary IM host timeout compatibility (#269)", () => {
  it("keeps unavailable and explicitly unlimited policies distinct", () => {
    expect(UNKNOWN_HOST_QUEUE_WAIT_MS).toBe(660_000);
    expect(UNLIMITED_HOST_QUEUE_WAIT_MS).toBe(1_800_000);
  });
  it.each([600_000, 172_800_000])("follows the running host's default %i, rather than a copied default", (budget) => {
    const cfg = {};
    const resolve = vi.fn(() => budget);
    expect(resolveImDispatchTimeoutMs(cfg, undefined, { agent: { resolveAgentTimeoutMs: resolve } })).toBe(budget + 60_000);
    expect(resolve).toHaveBeenCalledWith({ cfg });
  });
  it.each([MAX, Number.MAX_SAFE_INTEGER])("keeps unlimited/large host budgets timer safe (%i)", (budget) => {
    expect(resolveImDispatchTimeoutMs({}, undefined, { agent: { resolveAgentTimeoutMs: () => budget } })).toBe(MAX);
  });
  it("recognizes an explicit unlimited budget even when the host returns a finite sentinel", () => {
    expect(resolveImDispatchTimeoutMs({ agents: { defaults: { timeoutSeconds: 0 } } }, undefined, { agent: { resolveAgentTimeoutMs: () => 2147000000 } })).toBe(UNLIMITED_HOST_QUEUE_WAIT_MS);
  });
  it("uses a bounded queue-only recovery for unlimited hosts", () => {
    expect(resolveImDispatchTimeoutMs({}, undefined, { agent: { resolveAgentTimeoutMs: () => 0 } })).toBe(UNLIMITED_HOST_QUEUE_WAIT_MS);
  });
  it("warns only once per runtime when the host policy cannot be read", () => {
    const host = {}; const warn = vi.fn();
    resolveImDispatchTimeoutMs({}, undefined, host, warn);
    resolveImDispatchTimeoutMs({}, undefined, host, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("11-minute queue recovery"));
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
    expect(resolveImDispatchTimeoutMs({}, undefined, host, warn)).toBe(660_000);
    expect(warn).toHaveBeenCalledOnce();
    expect(resolveImDispatchTimeoutMs({ agents: { defaults: { timeoutSeconds: 0 } } }, undefined, host)).toBe(UNLIMITED_HOST_QUEUE_WAIT_MS);
  });
});
