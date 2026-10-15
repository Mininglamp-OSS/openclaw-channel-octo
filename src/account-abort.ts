/** One account-level listener, including dispatches that outlive their queue slot. */
const subscribers = new WeakMap<AbortSignal, { callbacks: Set<() => void>; abort: () => void }>();

export function subscribeAccountAbort(signal: AbortSignal | undefined, callback: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) { callback(); return () => {}; }
  let group = subscribers.get(signal);
  if (!group) {
    const callbacks = new Set<() => void>();
    group = { callbacks, abort: () => {
      subscribers.delete(signal);
      const pending = [...callbacks];
      callbacks.clear();
      for (const notify of pending) {
        try { notify(); }
        catch (err) { console.error("[octo] account abort subscriber failed", err); }
      }
    } };
    subscribers.set(signal, group);
    signal.addEventListener("abort", group.abort, { once: true });
  }
  group.callbacks.add(callback);
  return () => {
    group.callbacks.delete(callback);
    if (group.callbacks.size === 0 && subscribers.get(signal) === group) {
      signal.removeEventListener("abort", group.abort);
      subscribers.delete(signal);
    }
  };
}
