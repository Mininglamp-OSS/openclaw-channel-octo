// `/fork` inbound wiring (stage 2).
//
// Two pieces, both kept out of inbound.ts's body so the production hot path
// only gains a single `if (await handleForkCommandIfMatched(...)) return;`:
//
//   1. handleForkCommandIfMatched — the command splitter. Parses the command
//      body; if it is not `/fork`, returns false so the normal inbound flow
//      proceeds unchanged. If it is `/fork`, it is handled here (authorized →
//      run the fork; unauthorized → silently swallowed per spec §3.3) and the
//      caller early-returns BEFORE finalizeInboundContext / recordInboundSession
//      / the dispatch main path — so a fork never writes the parent session or
//      reaches the LLM on the parent conversation.
//
//   2. dispatchForkSeedReply — the "2B-minimal" seed dispatch seam (spec §5.2,
//      decided in stage-2 review). It drives the child-thread reply directly via
//      `dispatchReplyWithBufferedBlockDispatcher`, deliberately bypassing the
//      inbound mention gate (inbound.ts:1858): the fork is an already-decided
//      action, so it must NOT be re-litigated by the "should I respond?" gate.
//
// See docs/specs/2026-06-18-fork-command-design.md.

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import type { ReplyPayload, ReplyDispatchKind } from "openclaw/plugin-sdk/reply-runtime";

import { sendMessage } from "../api-fetch.js";
import type { ResolvedOctoAccount } from "../accounts.js";
import { CHANNEL_ID } from "../constants.js";
import { resolveDispatchTimeoutMs } from "../inbound.js";
import { convertStructuredMentions, parseStructuredMentions } from "../mention-utils.js";
import { getOctoRuntime } from "../runtime.js";
import { ChannelType, type MentionEntity } from "../types.js";
import { executeFork, parseForkCommand, type ForkLogger, type ForkOrchestrator } from "./fork.js";
import { buildForkOrchestrator, type ForkRuntimeDeps, type ForkSeedContext } from "./fork-runtime.js";

/**
 * Bounded timeout for the parent-group receipt send. The dispatch
 * timeout only guards the seed dispatch; without this, a hung Octo API on the
 * receipt POST would still strand the parent enqueueInbound serial queue. Mirrors
 * the `AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS)` pattern in inbound.ts.
 */
const RECEIPT_SEND_TIMEOUT_MS = 30_000;

/** Adapt the channel log sink to the {@link ForkLogger} signature. */
function toForkLogger(log?: ChannelLogSink): ForkLogger {
  return (level, message, meta) => {
    const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
    const sink = log?.[level] ?? log?.info;
    sink?.(`octo: ${line}`);
  };
}

/** Resolve the bot's `@[uid:name]` output into octo mention entities. */
function resolveSeedMentions(content: string): { content: string; entities: MentionEntity[] } {
  const structured = parseStructuredMentions(content);
  if (structured.length === 0) return { content, entities: [] };
  const converted = convertStructuredMentions(content, structured);
  return { content: converted.content, entities: [...converted.entities] };
}

/**
 * "2B-minimal" seed dispatch seam. Resolves the child thread's agent route,
 * stamps the runtime-derived `SessionKey` onto the seed context (the other half
 * of the auto-fork trigger — it must differ from `ParentSessionKey`), finalizes
 * the context, and runs the reply dispatcher delivering into the child thread.
 *
 * DELIBERATELY OMITTED vs the full inbound deliver harness (stage-2 review
 * decision; minimal divergence is acceptable for a one-shot seed):
 * - typing indicators / readReceipt — UX polish for interactive turns; a seed
 *   is a one-shot trigger, not a live conversation;
 * - OBO v2 (on_behalf_of) — OBO is the "reply as a grantor" path; a fork seed
 *   is the bot dispatching its own seed, so the OBO identity switch must NOT run;
 * - streaming buffer dedup / tool-warning deferral — the final-kind path covers
 *   the user-facing answer; the extra bookkeeping is interactive-turn polish;
 * - outbound media — the fork's first reply rarely carries media, and dropping
 *   it does not affect fork semantics (context/isolation). Revisit (and extract
 *   the shared harness) only if a real need appears — see spec §5.2.
 */
export async function dispatchForkSeedReply(params: {
  seedCtx: ForkSeedContext;
  childChannelId: string;
  accountId: string;
  account: ResolvedOctoAccount;
  apiUrl: string;
  botToken: string;
  config: OpenClawConfig;
  log?: ChannelLogSink;
}): Promise<void> {
  const { seedCtx, childChannelId, accountId, account, apiUrl, botToken, config, log } = params;
  const core = getOctoRuntime();

  const childRoute = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: "group", id: childChannelId },
  });

  // SessionKey completes the auto-fork trigger (get-reply forks when
  // ParentSessionKey !== SessionKey). It is intentionally resolved here, not in
  // assembleForkSeedContext, to avoid duplicating runtime routing.
  const ctx = {
    ...seedCtx,
    SessionKey: childRoute.sessionKey,
    AccountId: childRoute.accountId ?? accountId,
  };

  // Fork-isolation guard (fail-closed). get-reply only forks the parent
  // transcript when ParentSessionKey !== SessionKey. If they coincide, the seed
  // would run ON the
  // parent session and pollute it — the exact outcome /fork promises to avoid.
  // So we refuse to dispatch instead of warn-and-continue. Only reachable on a
  // user-defined group-merged route (octo's default per-thread routing gives the
  // child channelId a distinct sessionKey). The child thread already exists, so
  // spawnChildBoundSession turns this throw into seedFailed → the user is told to
  // resend in the now-live child thread.
  if (ctx.SessionKey === ctx.ParentSessionKey) {
    log?.warn?.(
      `octo: [fork-seed] isolation guard: SessionKey === ParentSessionKey (${ctx.SessionKey}) ` +
        `for child ${childChannelId} — refusing to dispatch (would pollute the parent session); ` +
        "only reachable on a user-defined group-merged route",
    );
    throw new Error(
      `fork isolation guard: child SessionKey collides with ParentSessionKey (${ctx.SessionKey})`,
    );
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext(ctx);

  const sendSeedText = async (content: string): Promise<void> => {
    const { content: finalContent, entities } = resolveSeedMentions(content);
    await sendMessage({
      apiUrl,
      botToken,
      channelId: childChannelId,
      channelType: ChannelType.CommunityTopic,
      content: finalContent,
      ...(entities.length > 0 ? { mentionEntities: entities } : {}),
    });
  };

  // Timeout guard (issue #75). dispatchReplyWithBufferedBlock-
  // Dispatcher is observed to occasionally hang forever (no resolve/reject/
  // onError). This seed is awaited synchronously inside the parent group's
  // enqueueInbound serial queue, so a bare await would lock that queue until the
  // gateway restarts. Race against the same per-inbound timeout as the normal
  // path (inbound.ts:2636) and rethrow on timeout so spawnChildBoundSession
  // surfaces seedFailed and the parent queue can advance.
  const dispatchTimeoutMs = resolveDispatchTimeoutMs(config, account);
  let dispatchTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(`octo: [fork-seed] dispatch timed out after ${dispatchTimeoutMs}ms`);
  const dispatchTimeoutPromise = new Promise<never>((_, reject) => {
    dispatchTimeoutHandle = setTimeout(() => reject(timeoutError), dispatchTimeoutMs);
  });

  const buffer = { lastText: null as string | null };
  let delivered = false;
  // The SDK dispatcher routes deliver()/onError failures WITHOUT
  // rejecting the outer promise, so a failed user-facing send would otherwise
  // look like fork success and the user gets "已开 fork 子区" while the first
  // reply never landed. Track delivery failure and convert it to a thrown error
  // after settle → spawnChildBoundSession seedFailed → ok_seed_failed.
  let deliverFailed = false;
  try {
    await Promise.race([
      core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        replyOptions: {},
        dispatcherOptions: {
          deliver: async (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => {
            if (payload.isReasoning) return;
            const content = payload.text?.trim() ?? "";
            if (!content) return;
            if (info.kind === "final" || info.kind === "tool") {
              try {
                await sendSeedText(content);
                delivered = true;
                buffer.lastText = null;
              } catch (sendErr) {
                // User-facing answer failed to send → the seed did not land.
                log?.error?.(`octo: [fork-seed] ${info.kind} send failed: ${String(sendErr)}`);
                deliverFailed = true;
              }
            } else {
              // block / other: buffer, flush once after the dispatcher settles
              buffer.lastText = content;
            }
          },
          onError: async (err: unknown, info: { kind: string }) => {
            log?.error?.(`octo: [fork-seed] ${info.kind} reply failed: ${String(err)}`);
            // A final/tool error means the user-facing reply did not land.
            if (info.kind === "final" || info.kind === "tool") {
              deliverFailed = true;
            }
          },
        },
      } as Parameters<typeof core.channel.reply.dispatchReplyWithBufferedBlockDispatcher>[0]),
      dispatchTimeoutPromise,
    ]);
  } catch (err) {
    if (err === timeoutError) {
      log?.warn?.(
        `octo: [fork-seed] dispatch hung past ${dispatchTimeoutMs}ms, aborting to unblock the ` +
          `parent group queue (child=${childChannelId})`,
      );
      // Suppress stale buffered text so the finally-flush does not send a partial
      // seed reply after we have already given up (mirrors inbound.ts:2797).
      buffer.lastText = null;
    }
    throw err; // → spawnChildBoundSession catch → seedFailed: true
  } finally {
    if (dispatchTimeoutHandle) clearTimeout(dispatchTimeoutHandle);
    // Isolate the flush. If the dispatcher already threw, a flush failure
    // must NOT replace the original error (it carries the root-cause signal).
    // Log and swallow the flush error; never let it shadow the dispatch error.
    if (buffer.lastText && !delivered) {
      try {
        await sendSeedText(buffer.lastText);
      } catch (flushErr) {
        log?.error?.(
          `octo: [fork-seed] finally flush failed: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`,
        );
      }
    }
  }

  // Settled without throwing, but a final/tool delivery may have failed silently
  // (the SDK does not reject the outer promise for deliver/onError failures).
  // Surface it so spawnChildBoundSession reports seedFailed → ok_seed_failed.
  if (deliverFailed) {
    throw new Error("octo: [fork-seed] delivery failed: user-facing reply did not send");
  }
}

/** Test seam: lets unit tests inject a fake orchestrator. */
export type BuildForkOrchestratorFn = (deps: ForkRuntimeDeps) => ForkOrchestrator;

/**
 * Detect and handle a `/fork` command at the inbound command-split point
 * (after `resolveCommandBody`, before `finalizeInboundContext`).
 *
 * @returns `true` when the message was a `/fork` command and has been fully
 *   handled — the caller MUST early-return. `false` when the message is not a
 *   fork command and normal inbound processing should continue.
 *
 * Authorization uses the already-computed `commandAuthorized` (owner-mentioned;
 * `commands.fork.scope` is a v1.1 wiring TODO). An unauthorized `/fork` is
 * swallowed silently (spec §3.3) — still returns `true` so it never reaches the
 * LLM. `/fork` in a DM is unsupported in v1 (no group to thread under): it sends
 * a hint and is swallowed (returns `true`), so the raw command never reaches the
 * LLM as ordinary text.
 */
export async function handleForkCommandIfMatched(params: {
  commandBody: string;
  commandAuthorized: boolean;
  isGroup: boolean;
  parentChannelId: string;
  parentChannelType: ChannelType;
  parentSessionKey: string;
  accountId: string;
  account: ResolvedOctoAccount;
  apiUrl: string;
  botToken: string;
  requesterUid: string;
  requesterName: string;
  config: OpenClawConfig;
  now?: () => Date;
  log?: ChannelLogSink;
  /** Injectable for tests; defaults to the real runtime orchestrator. */
  buildOrchestrator?: BuildForkOrchestratorFn;
}): Promise<boolean> {
  const parsed = parseForkCommand(params.commandBody);
  if (!parsed.ok && parsed.reason === "not_fork_command") {
    return false; // not /fork — let normal inbound flow proceed unchanged
  }

  // From here it IS a /fork attempt (a valid prompt, or empty).
  if (!params.isGroup) {
    // DM: /fork has no group to create a sub-thread under. Do NOT fall through
    // and let the raw "/fork ..." reach the LLM as ordinary text (that confuses
    // the user — they typed a command, not a question). Send a hint and swallow,
    // same shape as the unauthorized branch below (spec §3.1 drift fix, S5).
    params.log?.info?.("octo: [fork] /fork in DM is unsupported — sending hint, swallowed");
    try {
      await sendMessage({
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        channelId: params.parentChannelId,
        channelType: params.parentChannelType,
        content: "/fork 仅在群聊中可用",
      });
    } catch (err) {
      // Swallow — same shape as safeSendReceipt (fork.ts:215): a hint-send
      // failure must not bubble out of the inbound handler (it would otherwise
      // reach the enqueueInbound .catch as a generic handler error). Log so ops
      // keeps the send-failure signal. Keeps all three early-return branches
      // (DM / unauthorized / receipt) defensively consistent.
      params.log?.error?.(
        `octo: [fork] DM hint send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true; // swallow — never reaches the LLM
  }

  if (!params.commandAuthorized) {
    params.log?.info?.("octo: [fork] unauthorized /fork ignored silently");
    return true; // swallow per spec §3.3 — never reaches the LLM
  }

  const forkLog = toForkLogger(params.log);
  const build = params.buildOrchestrator ?? buildForkOrchestrator;

  const orchestrator = build({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    accountId: params.accountId,
    commandAuthorized: params.commandAuthorized,
    requesterUid: params.requesterUid,
    requesterName: params.requesterName,
    now: params.now ?? (() => new Date()),
    log: forkLog,
    sendParentReceipt: async ({ text }) => {
      await sendMessage({
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        channelId: params.parentChannelId,
        channelType: params.parentChannelType,
        content: text,
        // Bound the receipt POST so a hung Octo API cannot strand the parent
        // enqueueInbound queue. safeSendReceipt swallows the resulting
        // timeout error, so the fork's main effect (thread + seed) still stands.
        signal: AbortSignal.timeout(RECEIPT_SEND_TIMEOUT_MS),
      });
    },
    dispatchSeed: async (seedCtx) => {
      // Performance trade-off (stage-3 review S-6): this seed dispatch is awaited
      // synchronously inside the parent group's inbound handler, so it holds the
      // per-group serial queue (enqueueInbound, channel.ts) for ~the seed's
      // get-reply/LLM latency. Messages the user sends in the PARENT group during
      // that window queue behind it. Accepted for v1 (after /fork the user's
      // attention moves to the child thread); revisit by firing the seed async +
      // not awaiting if parent-queue latency becomes a problem — at the cost of
      // the create→seed→receipt atomicity.
      await dispatchForkSeedReply({
        seedCtx,
        childChannelId: seedCtx.GroupSubject,
        accountId: params.accountId,
        account: params.account,
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        config: params.config,
        log: params.log,
      });
    },
  });

  await executeFork(orchestrator, {
    prompt: parsed.ok ? parsed.prompt : "",
    parentChannelId: params.parentChannelId,
    parentSessionKey: params.parentSessionKey,
    now: params.now ?? (() => new Date()),
  });

  return true;
}
