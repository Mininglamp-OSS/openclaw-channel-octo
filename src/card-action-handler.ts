import { normalizeAccountId } from "./account-id.js";
import { editCardMessage } from "./api-fetch.js";
import { renderCardActionStatus, type CardActionStatus } from "./card-action-status.js";
import { validateCardActionInputs, type CardAction } from "./card-action.js";
import {
  claimCardSession,
  completeCardSession,
  lookupCardSession,
  nextCardSessionSeq,
  releaseCardSessionClaim,
  type CardSession,
} from "./card-session.js";
import { CARD_INTERACTIVE_PROFILE } from "./types.js";

export type CardActionHandleResult = "completed" | "duplicate" | "ignored" | "rejected";
export type CardActionDispatchResult = "completed" | "rejected";

/**
 * Upper bound on how many times a single card_action event is re-dispatched after a *throw*.
 * A throw is treated as transient and replayed by the poller (the cursor does not advance); once
 * this many attempts have failed the event is dead-lettered — the session is completed and the
 * cursor is allowed to advance — so one persistently-failing action can neither re-run the agent
 * turn forever nor block every later action for the account.
 */
const MAX_CARD_DISPATCH_ATTEMPTS = 3;

interface Params {
  action: CardAction;
  accountId: string;
  apiUrl: string;
  botToken: string;
  operatorName?: string;
  dispatch: (session: CardSession) => Promise<CardActionDispatchResult>;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}

async function updateStatus(params: {
  action: CardAction;
  session: CardSession;
  apiUrl: string;
  botToken: string;
  operator: string;
  status: CardActionStatus;
  submittedInputs?: Record<string, string>;
  errorText?: string;
  transient?: boolean;
  preserveControls?: boolean;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<void> {
  const rendered = renderCardActionStatus({
    card: params.session.card,
    plain: params.session.plain,
    ...(params.submittedInputs ? { inputs: params.submittedInputs } : {}),
    operator: params.operator,
    actionLabel: params.session.actionLabels[params.action.actionId] ?? params.action.actionId,
    status: params.status,
    ...(params.errorText ? { errorText: params.errorText } : {}),
    ...(params.preserveControls ? { preserveControls: true } : {}),
  });
  const cardSeq = nextCardSessionSeq(params.action.messageId);
  if (cardSeq === undefined) return;
  try {
    await editCardMessage({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      messageId: params.action.messageId,
      channelId: params.session.channelId,
      channelType: params.session.channelType,
      card: rendered.card,
      plain: rendered.plain,
      profile: CARD_INTERACTIVE_PROFILE,
      cardSeq,
      ...(params.transient ? { transient: true } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    params.log?.warn?.(
      `octo: card status edit failed message=${params.action.messageId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleCardAction(params: Params): Promise<CardActionHandleResult> {
  const { action } = params;
  const isReasoningControl =
    (action.actionId === "reasoning_stop" || action.actionId === "reasoning_retry") &&
    action.data?.action === action.actionId &&
    action.data?.owner === "ai" &&
    action.data?.action_type === "reasoning.control";
  if (isReasoningControl) {
    // The event poller will persist and ACK this normally. ACK means queue
    // consumption only; no cancellation/retry side effect is performed here.
    params.log?.warn?.(
      `octo: reasoning control is not supported action=${action.actionId} event=${action.eventId}`,
    );
    return "ignored";
  }
  const pendingSession = lookupCardSession(action.messageId);
  if (!pendingSession) {
    params.log?.warn?.(`octo: ignoring card_action for unknown/expired message=${action.messageId}`);
    return "ignored";
  }
  const identityMatches =
    normalizeAccountId(pendingSession.accountId) === normalizeAccountId(params.accountId) &&
    pendingSession.channelId === action.channelId &&
    pendingSession.channelType === action.channelType;
  const actionKnown = Object.hasOwn(pendingSession.actionLabels, action.actionId);
  if (!identityMatches || !actionKnown) {
    params.log?.warn?.(`octo: ignoring mismatched card_action message=${action.messageId}`);
    return "ignored";
  }

  const claim = claimCardSession(action.messageId, action.eventId);
  if (claim.status === "missing") return "ignored";
  if (claim.status === "duplicate") {
    params.log?.info?.(`octo: duplicate card_action ignored message=${action.messageId} event=${action.eventId}`);
    return "duplicate";
  }
  const session = claim.session;

  const inputs = validateCardActionInputs(action, session);
  if (!inputs.ok) {
    // Recoverable: release (not complete) so the user can correct the input and resubmit on the
    // same card. This event's cursor still advances (we return normally), so it does not replay.
    releaseCardSessionClaim(action.messageId, action.eventId);
    await updateStatus({
      action,
      session,
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      operator: params.operatorName ?? action.operatorUid,
      status: "error",
      errorText: inputs.error,
      preserveControls: true,
      log: params.log,
    });
    params.log?.warn?.(`octo: card_action rejected message=${action.messageId} reason=${inputs.error}`);
    return "rejected";
  }

  await updateStatus({
    action,
    session,
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    operator: params.operatorName ?? action.operatorUid,
    status: "processing",
    submittedInputs: action.inputs,
    transient: true,
    log: params.log,
  });
  try {
    const dispatchResult = await params.dispatch(session);
    if (dispatchResult === "rejected") {
      // A definitive drop for this event (e.g. session-init conflict already notified). Release
      // rather than complete so the "请稍后重试" hint is truthful — a fresh click can retry — while
      // this event's cursor still advances (returned normally) so it does not auto-replay.
      releaseCardSessionClaim(action.messageId, action.eventId);
      await updateStatus({
        action,
        session,
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        operator: params.operatorName ?? action.operatorUid,
        status: "error",
        submittedInputs: action.inputs,
        errorText: "处理失败，请稍后重试",
        preserveControls: true,
        log: params.log,
      });
      params.log?.warn?.(`octo: card_action dispatch rejected message=${action.messageId}`);
      return "rejected";
    }
    completeCardSession(action.messageId, action.eventId);
    await updateStatus({
      action,
      session,
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      operator: params.operatorName ?? action.operatorUid,
      status: "completed",
      submittedInputs: action.inputs,
      log: params.log,
    });
    params.log?.info?.(`octo: card_action completed message=${action.messageId} event=${action.eventId}`);
    return "completed";
  } catch (error) {
    // A throw is treated as transient and replayed by the poller (cursor stays put). Bound that
    // replay: after MAX attempts on the same event, dead-letter it — complete the session and
    // return normally so the cursor advances, instead of re-running the agent turn forever and
    // blocking every later action for this account.
    if (claim.attempts >= MAX_CARD_DISPATCH_ATTEMPTS) {
      completeCardSession(action.messageId, action.eventId);
      await updateStatus({
        action,
        session,
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        operator: params.operatorName ?? action.operatorUid,
        status: "error",
        submittedInputs: action.inputs,
        errorText: "处理失败，请稍后重新发起",
        log: params.log,
      });
      params.log?.warn?.(
        `octo: card_action giving up after ${claim.attempts} attempts message=${action.messageId} event=${action.eventId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "rejected";
    }
    releaseCardSessionClaim(action.messageId, action.eventId);
    await updateStatus({
      action,
      session,
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      operator: params.operatorName ?? action.operatorUid,
      status: "error",
      submittedInputs: action.inputs,
      errorText: "处理失败，正在重试",
      log: params.log,
    });
    throw error;
  }
}
