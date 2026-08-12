/**
 * Owner identity registry — maps accountId to the bot owner's UID.
 *
 * The owner_uid is obtained from registerBot() and registered during startAccount().
 * Owner users have full access to all cross-session queries.
 *
 * Case-insensitive lookup: octo-server BotFather can emit mixed-case bot IDs.
 * OpenClaw routes lowercased ones to plugin code, so this map normalizes at
 * the boundary to ensure register / query against any case form hits the
 * same entry. See issue #33 / src/account-id.ts.
 */

import { normalizeAccountId } from "./account-id.js";

const _ownerUidMap = new Map<string, string>(); // normalized accountId → owner_uid

export function registerOwnerUid(
  accountId: string,
  ownerUid: string | null | undefined,
): void {
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedOwnerUid = ownerUid?.trim();
  if (!normalizedOwnerUid) {
    _ownerUidMap.delete(normalizedAccountId);
    return;
  }
  _ownerUidMap.set(normalizedAccountId, normalizedOwnerUid);
}

/** Return the server-verified owner UID for an account, if registered. */
export function getOwnerUid(accountId: string): string | undefined {
  return _ownerUidMap.get(normalizeAccountId(accountId));
}

export function isOwner(accountId: string, uid: string): boolean {
  return getOwnerUid(accountId) === uid;
}

/** Visible for testing — clears all owner registrations. */
export function _clearOwnerRegistry(): void {
  _ownerUidMap.clear();
}
