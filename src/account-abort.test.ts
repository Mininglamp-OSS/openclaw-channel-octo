import { describe, it, expect, vi } from "vitest";
import { getEventListeners } from "node:events";
import { subscribeAccountAbort } from "./account-abort.js";

describe("account abort fanout", () => {
  it("keeps one listener for many pending dispatches and clears all on stop", () => {
    const controller = new AbortController();
    const callbacks = Array.from({ length: 25 }, () => vi.fn());
    const removers = callbacks.map(fn => subscribeAccountAbort(controller.signal, fn));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    removers[0]!();
    controller.abort();
    expect(callbacks[0]).not.toHaveBeenCalled();
    for (const fn of callbacks.slice(1)) expect(fn).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    for (const remove of removers) remove();
  });
  it("unsubscribes when the last dispatch settles and supports a new group", () => {
    const controller = new AbortController(); const fn = vi.fn();
    subscribeAccountAbort(controller.signal, fn)();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    subscribeAccountAbort(controller.signal, fn);
    controller.abort(); expect(fn).toHaveBeenCalledOnce();
  });
  it("isolates a throwing subscriber so every remaining run is cancelled", () => {
    const controller = new AbortController(); const next = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      subscribeAccountAbort(controller.signal, () => { throw new Error("cancel failed"); });
      subscribeAccountAbort(controller.signal, next);
      controller.abort();
      expect(next).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledOnce();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally { error.mockRestore(); }
  });
  it("immediately notifies a late subscriber to a stopped account", () => {
    const controller = new AbortController(); controller.abort(); const fn = vi.fn();
    subscribeAccountAbort(controller.signal, fn)();
    expect(fn).toHaveBeenCalledOnce();
  });
});
