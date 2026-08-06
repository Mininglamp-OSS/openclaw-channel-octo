import { getCardProfile, type CardProfileManifest } from "./api-fetch.js";

export interface BotCardProfileKey {
  apiUrl: string;
  botToken: string;
}

interface CachedProfile {
  manifest: CardProfileManifest;
  expiresAt: number;
}

interface BotCardProfileCacheState {
  cache: Map<string, CachedProfile>;
  inFlight: Map<string, Promise<CardProfileManifest>>;
  generations: Map<string, number>;
}

const CACHE_TTL_MS = 60_000;
const STATE_KEY = Symbol.for("openclaw.octo.bot-card-profile-cache.v1");

function getState(): BotCardProfileCacheState {
  const root = process as unknown as Record<PropertyKey, unknown>;
  const existing = root[STATE_KEY] as BotCardProfileCacheState | undefined;
  if (existing) return existing;
  const created: BotCardProfileCacheState = {
    cache: new Map(),
    inFlight: new Map(),
    generations: new Map(),
  };
  root[STATE_KEY] = created;
  return created;
}

const state = getState();

function cacheKey(params: BotCardProfileKey): string {
  return JSON.stringify([params.apiUrl.replace(/\/+$/, ""), params.botToken]);
}

function currentGeneration(key: string): number {
  return state.generations.get(key) ?? 0;
}

/** Synchronous best-effort read for tool discovery. Unknown/expired means "do not hide". */
export function peekBotCardProfile(params: BotCardProfileKey): CardProfileManifest | undefined {
  const key = cacheKey(params);
  const cached = state.cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    state.cache.delete(key);
    return undefined;
  }
  return cached.manifest;
}

/** Authoritative async read for execution paths, deduplicated and cached per Bot credential. */
export async function getBotCardProfile(params: BotCardProfileKey): Promise<CardProfileManifest> {
  const cached = peekBotCardProfile(params);
  if (cached) return cached;
  const key = cacheKey(params);
  const pending = state.inFlight.get(key);
  if (pending) return pending;

  const generation = currentGeneration(key);
  const work = getCardProfile(params).then((manifest) => {
    // A bot_setting_updated event may race this request. Never let the older response refill a
    // cache that the event already invalidated.
    if (currentGeneration(key) === generation) {
      state.cache.set(key, { manifest, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return manifest;
  }).finally(() => {
    if (state.inFlight.get(key) === work) state.inFlight.delete(key);
  });
  state.inFlight.set(key, work);
  return work;
}

/** Invalidate exactly one Bot; other tokens on the same deployment remain isolated. */
export function invalidateBotCardProfile(params: BotCardProfileKey): void {
  const key = cacheKey(params);
  state.cache.delete(key);
  state.inFlight.delete(key);
  state.generations.set(key, currentGeneration(key) + 1);
}

export function _resetBotCardProfileCacheForTests(): void {
  state.cache.clear();
  state.inFlight.clear();
  state.generations.clear();
}
