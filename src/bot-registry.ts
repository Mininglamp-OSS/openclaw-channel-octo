/**
 * Known-bot identity registry — tracks the robot_ids of every bot started by
 * this plugin instance, for bot-to-bot loop prevention.
 *
 * channel.ts registers each bot's uid during startAccount(); both the DM
 * loop-guard (channel.ts) and the group 免@ relaxation gate (inbound.ts)
 * consult isKnownBot() so the two paths stay in sync.
 *
 * Lives in its own module (rather than channel.ts) to avoid a circular import:
 * channel.ts imports handleInboundMessage from inbound.ts, so inbound.ts must
 * not import back from channel.ts.
 */

const _knownBotUids = new Set<string>();

/** Register a bot's robot_id so it can be recognised as a non-human sender. */
export function registerKnownBot(uid: string): void {
  if (uid) _knownBotUids.add(uid);
}

/** True when `uid` belongs to a bot started by this plugin instance. */
export function isKnownBot(uid: string): boolean {
  return _knownBotUids.has(uid);
}

/** Visible for testing — clears all registered bot uids. */
export function _clearKnownBots(): void {
  _knownBotUids.clear();
}

/** Visible for testing — current count of known bots. */
export function _knownBotCount(): number {
  return _knownBotUids.size;
}
