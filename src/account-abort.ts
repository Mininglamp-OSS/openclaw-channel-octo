import { WeakValueMap } from "./weak-value-map.js";

/** One account-level listener; the account must not own abandoned dispatches. */
type Group = { callbacks: WeakValueMap<symbol, () => void>; abort: () => void };
const subscribers = new WeakMap<AbortSignal, Group>();
// Some hosts retain only the run signal while a native operation is pending.
// Ephemeron ownership preserves cancellation without rooting abandoned signals.
const signalOwners = new WeakMap<AbortSignal, Set<() => void>>();

function removeEmptyGroup(signal: AbortSignal, group: Group): void {
  if (group.callbacks.size === 0 && subscribers.get(signal) === group) {
    signal.removeEventListener("abort", group.abort);
    subscribers.delete(signal);
  }
}

function notifySubscriber(callback: () => void): void {
  try { callback(); }
  catch (err) { console.error("[octo] account abort subscriber failed", err); }
}

// Separate closure scope: an account listener must never capture a subscriber.
function createGroup(signal: AbortSignal): Group {
  const weakSignal = new WeakRef(signal);
  const callbacks = new WeakValueMap<symbol, () => void>(() => {
    const source = weakSignal.deref();
    if (source) removeEmptyGroup(source, group);
  });
  const group: Group = { callbacks, abort: () => {
    subscribers.delete(signal);
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const notify of pending) notifySubscriber(notify);
  } };
  return group;
}

/** The live dispatch MUST retain the returned disposer until settlement/stop. */
export function subscribeAccountAbort(signal: AbortSignal | undefined, callback: () => void, runSignal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) { notifySubscriber(callback); return () => {}; }
  let group = subscribers.get(signal);
  if (!group) {
    group = createGroup(signal);
    subscribers.set(signal, group);
    signal.addEventListener("abort", group.abort, { once: true });
  }
  const key = Symbol();
  group.callbacks.set(key, callback);
  if (runSignal) {
    let owners = signalOwners.get(runSignal);
    if (!owners) signalOwners.set(runSignal, owners = new Set());
    owners.add(callback);
  }
  return () => {
    // This comparison pins callback in the disposer closure. A live dispatch
    // retaining its disposer therefore cannot lose account-stop cancellation.
    if (group.callbacks.get(key) === callback) group.callbacks.delete(key);
    if (runSignal) {
      const owners = signalOwners.get(runSignal);
      owners?.delete(callback);
      if (owners?.size === 0) signalOwners.delete(runSignal);
    }
    removeEmptyGroup(signal, group);
  };
}
