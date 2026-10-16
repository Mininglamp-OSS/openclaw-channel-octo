/**
 * Lookup only: the real producer/consumer must keep values alive. Unlike a Map,
 * this index cannot keep an abandoned dispatch alive just because it never settled.
 * Finalization removes dead keys; reads also prune them without waiting for GC's
 * finalization callback. There is deliberately no age-based eviction of live work.
 */
export class WeakValueMap<K, V extends object> {
  private readonly entries = new Map<K, WeakRef<V>>();
  private readonly notifications = new Set<K>();
  private notifying = false;
  private readonly collected = new FinalizationRegistry<{ key: K; ref: WeakRef<V> }>(held => {
    if (this.entries.get(held.key) !== held.ref) return;
    this.entries.delete(held.key);
    this.notifyCollected(held.key);
  });

  constructor(private readonly onCollected?: (key: K) => void) {}

  private notifyCollected(key: K): void {
    this.notifications.add(key);
    if (this.notifying) return;
    this.notifying = true;
    try {
      // Callbacks may inspect size/get and prune more dead entries. Drain those
      // notifications iteratively rather than recursively exhausting the stack.
      for (const pending of this.notifications) {
        this.notifications.delete(pending);
        this.onCollected?.(pending);
      }
    } finally { this.notifying = false; }
  }

  set(key: K, value: V): this {
    this.delete(key);
    const ref = new WeakRef(value);
    this.entries.set(key, ref);
    this.collected.register(value, { key, ref }, ref);
    return this;
  }

  get(key: K): V | undefined {
    const ref = this.entries.get(key);
    const value = ref?.deref();
    if (ref && !value) {
      this.delete(key);
      this.notifyCollected(key);
    }
    return value;
  }

  has(key: K): boolean { return this.get(key) !== undefined; }

  delete(key: K): boolean {
    const ref = this.entries.get(key);
    if (ref) this.collected.unregister(ref);
    return this.entries.delete(key);
  }

  clear(): void {
    for (const ref of this.entries.values()) this.collected.unregister(ref);
    this.entries.clear();
  }

  *values(): IterableIterator<V> {
    for (const key of this.entries.keys()) {
      const value = this.get(key);
      if (value) yield value;
    }
  }

  get size(): number {
    // Also prune dead weak refs when finalization has not run yet.
    for (const key of this.entries.keys()) this.get(key);
    return this.entries.size;
  }
}
