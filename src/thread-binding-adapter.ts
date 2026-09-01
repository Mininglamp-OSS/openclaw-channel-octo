/**
 * Octo SessionBindingAdapter — fixes octo-adapters#23 (thread_binding_invalid).
 *
 * OpenClaw's ACP runtime queries `getSessionBindingService().getCapabilities({channel,accountId})`
 * before spawning a thread-bound ACP session. If no SessionBindingAdapter is
 * registered for the channel+account, the service returns
 * `{ adapterAvailable: false, bindSupported: false }` and the runtime aborts
 * the spawn with `errorCode: "thread_binding_invalid"`.
 *
 * Reference impl: see Telegram's bundled adapter at
 * `node_modules/openclaw/dist/thread-bindings-BnqTb64l.js`.
 *
 * This adapter:
 *   - placement="current": records a binding against the current Octo
 *     conversationId without creating any new server-side resource. This is
 *     the most common path (binding a session to the active group / thread
 *     the user is talking in).
 *   - placement="child":  calls Octo `POST /v1/bot/groups/{groupNo}/threads`
 *     to create a new sub-thread, then records a binding against the
 *     resulting `groupNo____shortId` conversationId. This is the path used
 *     when an ACP session needs a fresh isolated sub-topic.
 *
 * Persistence is in-memory and per-account. Bindings are wiped when
 * `stopAccount` runs (e.g. on gateway restart). For first-iteration
 * correctness this is acceptable — ACP sessions themselves are not
 * persisted across restarts either, so a stale binding pointing to a dead
 * session would be useless. Future iterations can adopt the SDK's
 * `createAccountScopedConversationBindingManager` for disk-backed records.
 */
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
// The types come from conversation-runtime, which ships declarations for them;
// thread-bindings-runtime exports only `default` (no `types`) as of 2026.8.1, so
// its two functions are typed by a local shim instead — see
// openclaw-thread-bindings-runtime.d.ts.
import type {
  SessionBindingAdapter,
  SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { CHANNEL_ID, THREAD_ID_SEPARATOR } from "./constants.js";
import { createThread } from "./api-fetch.js";
import { normalizeAccountId } from "./account-id.js";

// SDK's `thread-bindings-runtime` only re-exports the adapter + record types.
// Derive the input types from the adapter signature itself to stay loosely
// coupled and avoid reaching into internal SDK subpaths.
type SessionBindingBindInput = Parameters<NonNullable<SessionBindingAdapter["bind"]>>[0];
type SessionBindingUnbindInput = Parameters<NonNullable<SessionBindingAdapter["unbind"]>>[0];
type ConversationRef = Parameters<SessionBindingAdapter["resolveByConversation"]>[0];

// normalizeAccountId moved to ./account-id.ts as the single source of truth
// for plugin-wide accountId normalization. See that file's doc for context
// (issue #33). All other modules that key on accountId import from there too.

type Logger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
} | undefined;

/**
 * Module-level binding registry, keyed by accountId. Each entry maps
 * bindingId → record. bindingId format is `${accountId}:${conversationId}`,
 * matching the Telegram adapter's convention.
 */
const _bindingsByAccount = new Map<string, Map<string, SessionBindingRecord>>();

function getOrCreateBindingMap(
  accountId: string,
): Map<string, SessionBindingRecord> {
  let m = _bindingsByAccount.get(accountId);
  if (!m) {
    m = new Map();
    _bindingsByAccount.set(accountId, m);
  }
  return m;
}

function buildBindingId(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

function deriveThreadName(
  metadata: Record<string, unknown> | undefined,
  targetSessionKey: string,
): string {
  const md = metadata ?? {};
  const fromMd =
    (typeof md.threadName === "string" && md.threadName.trim()) ||
    (typeof md.label === "string" && md.label.trim()) ||
    "";
  if (fromMd) return fromMd as string;
  const tail = targetSessionKey.split(":").pop() ?? "session";
  return `Agent: ${tail}`;
}

/**
 * Resolve the parent group_no from a child conversationId. Octo encodes
 * threads as `groupNo____shortId` (4 underscores). When the caller passes
 * a parent conversationId that is itself a thread ref, strip the suffix.
 */
function resolveParentGroupNo(
  conversation: SessionBindingBindInput["conversation"],
): string | null {
  const raw =
    conversation.parentConversationId?.trim() ||
    conversation.conversationId?.trim() ||
    "";
  if (!raw) return null;
  return raw.includes(THREAD_ID_SEPARATOR)
    ? raw.split(THREAD_ID_SEPARATOR)[0]!
    : raw;
}

export interface RegisterOctoThreadBindingAdapterParams {
  accountId: string;
  apiUrl: string;
  /** Bot token (bf_...). Used by the `child` placement to create new threads. */
  botToken: string;
  log?: Logger;
}

/**
 * Register a SessionBindingAdapter for one Octo account. Call once per
 * account during `startAccount`. Returns an unregister function that the
 * caller MUST invoke during `stopAccount` (or the abortSignal cleanup
 * path) to keep the SDK registry in sync across hot reloads.
 */
export function registerOctoThreadBindingAdapter(
  params: RegisterOctoThreadBindingAdapterParams,
): () => void {
  const { apiUrl, botToken, log } = params;
  // Normalize the account id ONCE here. Every internal map key, bindingId,
  // and ref comparison below uses `accountId` (the normalized form), never
  // params.accountId. The SDK invokes adapter methods with already-normalized
  // refs, so this keeps both halves of the round-trip aligned.
  const accountId = normalizeAccountId(params.accountId);

  const adapter: SessionBindingAdapter = {
    channel: CHANNEL_ID,
    accountId,
    capabilities: {
      placements: ["current", "child"],
      bindSupported: true,
      unbindSupported: true,
    },

    bind: async (
      input: SessionBindingBindInput,
    ): Promise<SessionBindingRecord | null> => {
      // Defensive: SDK should already filter by channel/accountId, but the
      // adapter contract permits us to no-op on mismatched input. Mirror the
      // same normalization that `resolveByConversation` applies so a direct
      // caller passing a mixed-case accountId still routes correctly here.
      if (input.conversation.channel !== CHANNEL_ID) return null;
      if (normalizeAccountId(input.conversation.accountId) !== accountId) return null;

      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) return null;

      const placement: "current" | "child" =
        input.placement === "child" ? "child" : "current";

      let conversationId: string;
      let parentConversationId: string | undefined;

      if (placement === "child") {
        const parentGroupNo = resolveParentGroupNo(input.conversation);
        if (!parentGroupNo) {
          log?.warn?.(
            `octo: [${accountId}] child bind failed — could not resolve parent group_no from conversation=${JSON.stringify(input.conversation)}`,
          );
          return null;
        }
        const threadName = deriveThreadName(input.metadata, targetSessionKey);
        try {
          const thread = await createThread({
            apiUrl,
            botToken,
            groupNo: parentGroupNo,
            name: threadName,
          });
          conversationId = `${parentGroupNo}${THREAD_ID_SEPARATOR}${thread.short_id}`;
          parentConversationId = parentGroupNo;
          log?.info?.(
            `octo: [${accountId}] child thread created group=${parentGroupNo} short_id=${thread.short_id} (name="${threadName}")`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log?.warn?.(
            `octo: [${accountId}] createThread failed for group=${parentGroupNo}: ${message}`,
          );
          return null;
        }
      } else {
        // placement === "current": bind to the conversationId the caller is
        // already in. No new server-side resource is created.
        const raw = input.conversation.conversationId?.trim();
        if (!raw) return null;
        conversationId = raw;
        parentConversationId = input.conversation.parentConversationId;
      }

      const now = Date.now();
      const record: SessionBindingRecord = {
        bindingId: buildBindingId(accountId, conversationId),
        targetSessionKey,
        targetKind: input.targetKind,
        conversation: {
          channel: CHANNEL_ID,
          accountId,
          conversationId,
          ...(parentConversationId ? { parentConversationId } : {}),
        },
        status: "active",
        boundAt: now,
        ...(input.ttlMs ? { expiresAt: now + input.ttlMs } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };

      getOrCreateBindingMap(accountId).set(record.bindingId, record);
      log?.info?.(
        `octo: [${accountId}] bound conversation=${conversationId} → session=${targetSessionKey} (placement=${placement}, kind=${input.targetKind})`,
      );
      return record;
    },

    listBySession: (targetSessionKey: string): SessionBindingRecord[] => {
      const m = _bindingsByAccount.get(accountId);
      if (!m) return [];
      const out: SessionBindingRecord[] = [];
      for (const rec of m.values()) {
        if (rec.targetSessionKey === targetSessionKey) out.push(rec);
      }
      return out;
    },

    resolveByConversation: (ref: ConversationRef): SessionBindingRecord | null => {
      // ref.accountId is already lowercased by the SDK (see normalizeAccountId
      // doc-comment at top of this file). Defensively normalize again so a
      // direct adapter-level caller (e.g. test code) bypassing the SDK still
      // gets a correct result.
      if (ref.channel !== CHANNEL_ID) return null;
      const refAccountId = normalizeAccountId(ref.accountId);
      if (refAccountId !== accountId) return null;
      const m = _bindingsByAccount.get(accountId);
      if (!m) return null;
      return m.get(buildBindingId(accountId, ref.conversationId)) ?? null;
    },

    touch: (_bindingId: string, _at?: number): void => {
      // The in-memory adapter has no idle-expiry sweeper, so touch is
      // intentionally a no-op. Implementing it would require a `lastTouchedAt`
      // field on records that nothing currently reads. Kept for SDK contract
      // compliance and to avoid adapter-shape surprises if the runtime calls it.
    },

    unbind: async (
      input: SessionBindingUnbindInput,
    ): Promise<SessionBindingRecord[]> => {
      const m = _bindingsByAccount.get(accountId);
      if (!m) return [];
      const removed: SessionBindingRecord[] = [];
      if (input.bindingId) {
        const rec = m.get(input.bindingId);
        if (rec) {
          m.delete(input.bindingId);
          removed.push({ ...rec, status: "ended" });
        }
      } else if (input.targetSessionKey) {
        const target = input.targetSessionKey;
        for (const [key, rec] of Array.from(m.entries())) {
          if (rec.targetSessionKey === target) {
            m.delete(key);
            removed.push({ ...rec, status: "ended" });
          }
        }
      }
      if (removed.length > 0) {
        log?.info?.(
          `octo: [${accountId}] unbound ${removed.length} binding(s) (reason: ${input.reason})`,
        );
      }
      return removed;
    },
  };

  registerSessionBindingAdapter(adapter);
  log?.info?.(
    `octo: [${accountId}] registered SessionBindingAdapter (placements=current,child)`,
  );

  let unregistered = false;
  return function unregister() {
    if (unregistered) return;
    unregistered = true;
    unregisterSessionBindingAdapter({
      channel: CHANNEL_ID,
      accountId,
      adapter,
    });
    _bindingsByAccount.delete(accountId);
    log?.info?.(`octo: [${accountId}] unregistered SessionBindingAdapter`);
  };
}

/** Test-only: clear the in-memory binding registry across all accounts. */
export function __resetOctoThreadBindingsForTests(): void {
  _bindingsByAccount.clear();
}
