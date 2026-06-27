import { describe, it, expect, beforeEach } from "vitest";
import {
  touchCache,
  cleanupStaleCaches,
  _test_caches,
  _test_CACHE_MAX_AGE_MS,
} from "./channel.js";

/**
 * Regression test for issue #128:
 * cleanupStaleCaches deletes per-group cache entries by raw channel_id
 * (from touchCache), but _groupCacheTimestamps and _currentGroupMembersMaps
 * are keyed by parent groupNo (from extractParentGroupNo). For thread
 * channels (channel_id = "parentGroupNo____shortId"), the delete never
 * matches → cache entries are never reclaimed.
 */

const ACCOUNT = "test-account-128";
const PARENT_GROUP = "G001";
const THREAD_CHANNEL = `${PARENT_GROUP}____thread1`;
const PLAIN_GROUP = "G002";

describe("issue #128 — cleanupStaleCaches parent-key leak", () => {
  beforeEach(() => {
    _test_caches.clear();
  });

  it("should clean up _groupCacheTimestamps entries for thread channels", () => {
    // Simulate: thread message arrives
    // 1. touchCache records raw channel_id
    const staleTime = Date.now() - _test_CACHE_MAX_AGE_MS - 1000;
    _test_caches.setActivity(ACCOUNT, THREAD_CHANNEL, staleTime);
    // 2. refreshGroupMemberCache writes under parent groupNo
    _test_caches.setGroupCacheTimestamp(ACCOUNT, PARENT_GROUP, staleTime);

    // Verify setup: both maps have entries
    expect(
      _test_caches.cacheActivity.get("test-account-128")?.has(THREAD_CHANNEL),
    ).toBe(true);
    expect(
      _test_caches.groupCacheTimestamps
        .get("test-account-128")
        ?.has(PARENT_GROUP),
    ).toBe(true);

    // Run cleanup
    cleanupStaleCaches();

    // Both entries should be cleaned up
    expect(
      _test_caches.groupCacheTimestamps
        .get("test-account-128")
        ?.has(PARENT_GROUP) ?? false,
    ).toBe(false);
  });

  it("should clean up _currentGroupMembersMaps entries for thread channels", () => {
    const staleTime = Date.now() - _test_CACHE_MAX_AGE_MS - 1000;
    _test_caches.setActivity(ACCOUNT, THREAD_CHANNEL, staleTime);
    // In reality, refreshGroupMemberCache sets BOTH timestamps and roster
    _test_caches.setGroupCacheTimestamp(ACCOUNT, PARENT_GROUP, staleTime);
    _test_caches.setCurrentGroupMembers(ACCOUNT, PARENT_GROUP, [
      { uid: "u1", name: "Alice" },
    ]);

    // Verify setup
    expect(
      _test_caches.currentGroupMembersMaps
        .get("test-account-128")
        ?.has(PARENT_GROUP),
    ).toBe(true);

    cleanupStaleCaches();

    // Both parent-keyed entries should be cleaned up
    expect(
      _test_caches.groupCacheTimestamps
        .get("test-account-128")
        ?.has(PARENT_GROUP) ?? false,
    ).toBe(false);
    expect(
      _test_caches.currentGroupMembersMaps
        .get("test-account-128")
        ?.has(PARENT_GROUP) ?? false,
    ).toBe(false);
  });

  it("should still clean up plain groups (no ____ separator)", () => {
    const staleTime = Date.now() - _test_CACHE_MAX_AGE_MS - 1000;
    _test_caches.setActivity(ACCOUNT, PLAIN_GROUP, staleTime);
    _test_caches.setGroupCacheTimestamp(ACCOUNT, PLAIN_GROUP, staleTime);
    _test_caches.setCurrentGroupMembers(ACCOUNT, PLAIN_GROUP, [
      { uid: "u2", name: "Bob" },
    ]);

    cleanupStaleCaches();

    // Both should be cleaned up (extractParentGroupNo returns plain group as-is)
    expect(
      _test_caches.groupCacheTimestamps
        .get("test-account-128")
        ?.has(PLAIN_GROUP) ?? false,
    ).toBe(false);
    expect(
      _test_caches.currentGroupMembersMaps
        .get("test-account-128")
        ?.has(PLAIN_GROUP) ?? false,
    ).toBe(false);
  });

  it("should clean orphaned parent-groupNo entries (no raw-key activity)", () => {
    // Scenario: thread activity was the only thing keeping parent alive,
    // but the raw thread entry in _cacheActivity was already cleaned up
    // in a previous pass. Now the parent-keyed maps have orphan entries.
    const staleTime = Date.now() - _test_CACHE_MAX_AGE_MS - 1000;
    // No _cacheActivity entry for anything related to this parent
    // But parent-keyed maps still have entries
    _test_caches.setGroupCacheTimestamp(ACCOUNT, PARENT_GROUP, staleTime);
    _test_caches.setCurrentGroupMembers(ACCOUNT, PARENT_GROUP, [
      { uid: "u1", name: "Alice" },
    ]);

    cleanupStaleCaches();

    // Orphaned entries should be cleaned up
    expect(
      _test_caches.groupCacheTimestamps
        .get("test-account-128")
        ?.has(PARENT_GROUP) ?? false,
    ).toBe(false);
    expect(
      _test_caches.currentGroupMembersMaps
        .get("test-account-128")
        ?.has(PARENT_GROUP) ?? false,
    ).toBe(false);
  });

  it("should NOT clean parent entries when sibling thread is still active", () => {
    // Setup: two threads from same parent. One stale, one fresh.
    const now = Date.now();
    const staleTime = now - _test_CACHE_MAX_AGE_MS - 1000;
    const freshTime = now - 1000;

    // Thread 1 is stale
    _test_caches.setActivity(ACCOUNT, `${PARENT_GROUP}____thread_stale`, staleTime);
    // Thread 2 is still active
    _test_caches.setActivity(ACCOUNT, `${PARENT_GROUP}____thread_fresh`, freshTime);
    // Parent-keyed maps were refreshed by thread 2's message
    _test_caches.setGroupCacheTimestamp(ACCOUNT, PARENT_GROUP, freshTime);
    _test_caches.setCurrentGroupMembers(ACCOUNT, PARENT_GROUP, [
      { uid: "u1", name: "Alice" },
    ]);

    cleanupStaleCaches();

    // Parent should still be alive (thread_fresh keeps it warm)
    expect(
      _test_caches.groupCacheTimestamps
        .get("test-account-128")
        ?.has(PARENT_GROUP),
    ).toBe(true);
    expect(
      _test_caches.currentGroupMembersMaps
        .get("test-account-128")
        ?.has(PARENT_GROUP),
    ).toBe(true);

    // Stale thread's raw entry should be cleaned
    expect(
      _test_caches.cacheActivity
        .get("test-account-128")
        ?.has(`${PARENT_GROUP}____thread_stale`) ?? false,
    ).toBe(false);

    // Fresh thread should still be there
    expect(
      _test_caches.cacheActivity
        .get("test-account-128")
        ?.has(`${PARENT_GROUP}____thread_fresh`),
    ).toBe(true);
  });
});
