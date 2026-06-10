/**
 * Pure constants and pure functions for plugin/channel identifiers.
 *
 * **Layering rule**:
 * This file is `src/`-only and has no fs/child_process dependencies, so it can
 * be safely imported from both runtime code (`src/*.ts`) and CLI code
 * (`cli/*.ts`). Runtime code MUST NOT import from `cli/`.
 */

/**
 * OpenClaw runtime/install/config/inspect identifier for this plugin.
 * Must match `openclaw.plugin.json#id` and `package.json#openclaw.id`.
 */
export const PLUGIN_ID = "octo";


export const CHANNEL_ID = "octo";

/**
 * Separator between parent group_no and thread short_id in Octo's CommunityTopic
 * channel ID format (`<groupNo>____<shortId>`, 4 underscores). Centralized here
 * to avoid drift across modules that need to split or compose thread refs.
 */
export const THREAD_ID_SEPARATOR = "____";

/**
 * Strip any of the known channel namespace prefixes (`octo:`, `channel:`,
 * `group:`) from a channelId / sessionKey / target string. Strips
 * **recursively** — stacked prefixes such as `"octo:group:grp1"` or
 * `"channel:octo:grp1"` are stripped down to `"grp1"` in one call.
 * Fully idempotent for any input.
 *
 * Why three prefixes: the OpenClaw runtime passes channel ids through several
 * layers (gateway, plugin SDK, agent tool context) and different layers
 * historically attach different namespace prefixes. Comparisons between
 * channel ids therefore need a single normalization step that strips
 * whichever prefix is present, so two callers do not silently miscompare
 * `"octo:grp1"` against `"grp1"` or `"channel:grp1"` against `"group:grp1"`.
 *
 * Recursive vs. the old chained-replace site: the previous threadId-parsing
 * site at src/actions.ts ran `replace(/^octo:/)` then `replace(/^group:/)`
 * then `replace(/^channel:/)`, which collapsed some stacked forms (e.g.
 * `"octo:group:topicA"` → `"topicA"`) but NOT all (e.g.
 * `"channel:octo:grp1"` → `"octo:grp1"`, because only the final
 * `channel:` replace stripped the outer layer and the chain never re-ran
 * `octo:` against the now-exposed inner prefix). The recursive helper is
 * **intentionally broader** than the old chain: it canonicalizes any order
 * of stacked runtime prefixes. Net effect is strictly safer for downstream
 * comparisons and matches the helper's "all channel prefixes" name.
 *
 * Note: this is a prefix-strip, not a prefix-rewrite. `normalizeOutboundChannelPrefix`
 * in src/actions.ts is a different operation that canonicalises outbound
 * channel-group targets to a single leading `group:` (and shares this
 * recursive collapse internally to handle stacked outbound forms safely).
 */
export function stripAllChannelPrefixes(s: string): string {
  let out = s;
  // Loop bounded by the number of leading runtime prefixes (at most a
  // handful in any realistic input). Each iteration strictly shortens
  // `out`, so termination is guaranteed regardless of order.
  while (true) {
    const next = out.replace(/^(octo:|channel:|group:)/, "");
    if (next === out) return out;
    out = next;
  }
}

/** Return the per-channel sub-config for the current channel id (runtime read). */
export function getChannelConfig<T = unknown>(cfg: any): T {
  return (cfg?.channels?.[CHANNEL_ID] ?? {}) as T;
}

/**
 * Lazily ensure `cfg.channels.<CHANNEL_ID>` exists and return the mutable
 * reference. Used to write account configuration.
 */
export function ensureChannelConfigObject(cfg: any): any {
  cfg.channels ??= {};
  cfg.channels[CHANNEL_ID] ??= {};
  cfg.channels[CHANNEL_ID].accounts ??= {};
  return cfg.channels[CHANNEL_ID];
}
