/**
 * Per-(bot, group) "免@偏好" cache.
 *
 * A group admin can mark a group as `no_mention=true` for a specific bot,
 * meaning that bot replies to *every* message in the group without needing
 * an explicit @mention. The mention gate in inbound.ts consults this cache
 * to decide, per message, whether `requireMention` should be relaxed.
 *
 * Design mirrors member-cache.ts: a plain Map with per-entry TTL, lazy
 * (pull-on-miss) refresh, and an explicit invalidate hook. Freshness is driven
 * primarily by an event: the backend (octo-server#242) pushes a
 * `mention_pref_updated` notification when an owner toggles 免@, which inbound.ts
 * intercepts and turns into invalidateMentionPref(accountId, groupNo) so the
 * next message re-pulls via GET /v1/bot/groups/:group_no/mention_pref
 * (octo-server#237). TTL is only a backstop should that event be dropped — a
 * stale entry self-heals within one (short) TTL window.
 *
 * IMPORTANT: the cache key is the COMPOSITE `${accountId}:${parentGroupNo}`,
 * never the bare groupNo. The preference is per-bot — two bots in the same
 * group can have independent 免@ settings, and keying on groupNo alone would
 * cross-contaminate them.
 *
 * Thread (compound channel_id) messages must resolve their PARENT group_no
 * (via extractParentGroupNo) before calling in, so a thread inherits its
 * parent group's preference.
 */

import { getMentionPref, fetchBotGroups, type MentionPref } from "./api-fetch.js";
import type { LogSink } from "./types.js";

const CACHE_TTL_MS = 30 * 1000; // 30 seconds (positive: no_mention=true)
// The cache is kept fresh primarily by the `mention_pref_updated` event (handled
// in inbound.ts), which invalidates the affected (bot, group) entry the instant
// an owner toggles 免@. TTL is now only a backstop: should that event ever be
// dropped, a stale positive (免@) result self-heals within 30s instead of being
// pinned for minutes. This is aligned with NEGATIVE_CACHE_TTL_MS below.
// Negative results (no_mention=false) share the same short TTL. getMentionPref
// returns no_mention=false BOTH for a genuine "needs @" group AND as its failure
// fallback, so without a short TTL a transient backend blip would pin
// no_mention=false and delay a freshly-enabled 免@ from taking effect.
const NEGATIVE_CACHE_TTL_MS = 30 * 1000; // 30 seconds

interface CacheEntry {
  pref: MentionPref;
  expiry: number;
}

const _prefCache = new Map<string, CacheEntry>();

/** Build the composite per-bot cache key. */
function cacheKey(accountId: string, parentGroupNo: string): string {
  return `${accountId}:${parentGroupNo}`;
}

/**
 * Get the 免@偏好 for a (bot, group) pair, refreshing lazily on miss/expiry.
 *
 * On a fetch failure getMentionPref already returns `{ no_mention: false }`
 * (account-level fallback). We still cache that, but with a shorter
 * NEGATIVE_CACHE_TTL_MS so a flaky backend doesn't hammer the API on every
 * inbound message yet a freshly-enabled 免@ surfaces within ~30s rather than
 * being masked for longer.
 */
export async function getMentionPrefFromCache(params: {
  accountId: string;
  parentGroupNo: string;
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<MentionPref> {
  const key = cacheKey(params.accountId, params.parentGroupNo);
  const cached = _prefCache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.pref;

  const pref = await getMentionPref({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.parentGroupNo,
    log: params.log
      ? {
          info: (...a: unknown[]) => params.log!.info?.(String(a[0])),
          error: (...a: unknown[]) => params.log!.error?.(String(a[0])),
        }
      : undefined,
  });
  const ttl = pref.no_mention ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  _prefCache.set(key, { pref, expiry: Date.now() + ttl });
  return pref;
}

/** Invalidate a single (bot, group) entry. */
export function invalidateMentionPref(accountId: string, parentGroupNo: string): void {
  _prefCache.delete(cacheKey(accountId, parentGroupNo));
}

/**
 * Preload 免@偏好 for all of a bot's groups (fire-and-forget at startup).
 *
 * Optional warm-up — the gate works purely lazily without it; this just
 * avoids a first-message latency bump and a thundering pull when a busy
 * group wakes up. Per-group failures are swallowed (getMentionPref already
 * falls back to no_mention=false), so a flaky backend degrades to lazy load.
 */
export async function preloadMentionPrefs(params: {
  accountId: string;
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<void> {
  const apiLog = params.log
    ? {
        info: (...a: unknown[]) => params.log!.info?.(String(a[0])),
        error: (...a: unknown[]) => params.log!.error?.(String(a[0])),
      }
    : undefined;
  let groups: { group_no: string }[];
  try {
    groups = await fetchBotGroups({ apiUrl: params.apiUrl, botToken: params.botToken, log: apiLog });
  } catch {
    return; // degrade to lazy load
  }
  let count = 0;
  for (const g of groups) {
    if (!g?.group_no) continue;
    try {
      await getMentionPrefFromCache({
        accountId: params.accountId,
        parentGroupNo: g.group_no,
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        log: params.log,
      });
      count++;
    } catch {
      // Ignore per-group failures
    }
  }
  if (count > 0) {
    params.log?.info?.(`octo: mention-pref preloaded ${count} groups`);
  }
}

/** Visible for testing — clears all cached preferences. */
export function _clearMentionPrefCache(): void {
  _prefCache.clear();
}

/** Visible for testing — directly set a cache entry. */
export function _setMentionPrefEntry(
  accountId: string,
  parentGroupNo: string,
  pref: MentionPref,
  ttlMs?: number,
): void {
  _prefCache.set(cacheKey(accountId, parentGroupNo), {
    pref,
    expiry: Date.now() + (ttlMs ?? CACHE_TTL_MS),
  });
}

/** Visible for testing — check whether an entry exists (ignoring expiry). */
export function _hasMentionPrefEntry(accountId: string, parentGroupNo: string): boolean {
  return _prefCache.has(cacheKey(accountId, parentGroupNo));
}
