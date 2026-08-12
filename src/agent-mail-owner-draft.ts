import { normalizeAccountId } from "./account-id.js";
import { ChannelType, MessageType, type BotMessage } from "./types.js";

export const OCTO_AGENT_MAIL_OWNER_DRAFT_CAPABILITY =
  "octo.agent-mail.owner-draft.v1";

const CONFIRMATION_TTL_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DRAFT_ID_PATTERN = /^E[1-9][0-9]*$/;

type PreparedOwnerDraft = {
  accountId: string;
  sessionKey: string;
  mailboxId: string;
  draftId: string;
  draftVersion: number;
  status: "prepared";
  preparedAtTimestamp: number;
  expiresAtMs: number;
};

type OwnerDraftConfirmation = Omit<PreparedOwnerDraft, "status" | "expiresAtMs"> & {
  status: "confirmed";
  spaceId: string;
  ownerUid: string;
  messageId: string;
  expiresAtMs: number;
};

type OwnerDraftState = PreparedOwnerDraft | OwnerDraftConfirmation;

export type OwnerDraftDeliveryInput = {
  sessionKey: string;
  mailboxId: string;
  draftId: string;
  draftVersion: number;
  signal?: AbortSignal;
};

export type OwnerDraftDeliveryResult = {
  outcome: "accepted";
  messageId: string;
  submissionIds: string[];
  senderAddress?: string;
};

export interface OwnerDraftDeliveryCapability {
  prepareOwnerDraft(input: OwnerDraftDeliveryInput): void;
  sendOwnerDraft(input: OwnerDraftDeliveryInput): Promise<OwnerDraftDeliveryResult>;
}

const ownerDraftStates = new Map<string, OwnerDraftState>();
// Keep a process-local tombstone for authoritative inbound messages.
// WKSocket acknowledges before dispatch, but a reconnect or event replay may
// still redeliver the same message. One OCTO message may grant at most once,
// even after its active account/session confirmation has been consumed.
// Only an authenticated Owner's exact confirmation can enter this set, and all
// entries are cleared when the account or process state is cleared.
const recordedConfirmationMessages = new Set<string>();

function confirmationKey(accountId: string, sessionKey: string): string {
  return `${normalizeAccountId(accountId)}\0${sessionKey}`;
}

function confirmationMessageKey(accountId: string, messageId: string): string {
  return `${normalizeAccountId(accountId)}\0${messageId}`;
}

/** Record only an exact, server-identified Owner DM confirmation. */
export function recordOwnerDraftConfirmation(input: {
  accountId: string;
  sessionKey: string;
  spaceId: string;
  ownerUid: string | undefined;
  message: BotMessage;
  nowMs?: number;
}): boolean {
  pruneExpired(input.nowMs);
  const content = input.message.payload?.content;
  if (
    !input.ownerUid ||
    input.message.from_uid !== input.ownerUid ||
    input.message.channel_type !== ChannelType.DM ||
    input.message.payload?.type !== MessageType.Text ||
    typeof content !== "string" ||
    content.trim() !== "确认发送" ||
    input.sessionKey.trim() === "" ||
    input.spaceId.trim() === "" ||
    input.message.message_id.trim() === ""
  ) {
    return false;
  }

  const accountId = normalizeAccountId(input.accountId);
  const messageId = input.message.message_id.trim();
  const messageKey = confirmationMessageKey(accountId, messageId);
  if (recordedConfirmationMessages.has(messageKey)) return false;
  recordedConfirmationMessages.add(messageKey);

  const key = confirmationKey(accountId, input.sessionKey);
  const prepared = ownerDraftStates.get(key);
  if (prepared?.status !== "prepared") return false;
  if (
    !Number.isSafeInteger(input.message.timestamp) ||
    input.message.timestamp < prepared.preparedAtTimestamp
  ) {
    return false;
  }

  const now = input.nowMs ?? Date.now();
  const value: OwnerDraftConfirmation = {
    ...prepared,
    status: "confirmed",
    spaceId: input.spaceId,
    ownerUid: input.ownerUid,
    messageId,
    expiresAtMs: now + CONFIRMATION_TTL_MS,
  };
  ownerDraftStates.set(key, value);
  return true;
}

export function createOwnerDraftDeliveryCapability(input: {
  accountId: string;
  apiUrl: string;
  botToken: string;
  getCurrentOwnerUid: () => string | undefined;
  fetchImpl?: typeof fetch;
}): OwnerDraftDeliveryCapability {
  const accountId = normalizeAccountId(input.accountId);
  const apiUrl = input.apiUrl.replace(/\/+$/, "");
  const botToken = input.botToken.trim();
  const fetchImpl = input.fetchImpl ?? fetch;
  if (!apiUrl || !botToken) {
    throw new Error("OCTO Agent Mail owner Draft capability is not configured");
  }

  return {
    prepareOwnerDraft(request) {
      validateDeliveryInput(request);
      pruneExpired();
      const key = confirmationKey(accountId, request.sessionKey);
      const current = ownerDraftStates.get(key);
      if (current?.status === "confirmed") {
        throw new Error(
          "An Owner-confirmed mail Draft is already pending delivery for this OCTO account and session.",
        );
      }
      const mailboxId = request.mailboxId.trim();
      if (current?.status === "prepared") {
        if (
          current.mailboxId === mailboxId &&
          current.draftId === request.draftId &&
          current.draftVersion === request.draftVersion
        ) {
          return;
        }
        throw new Error(
          "A different mail Draft is already awaiting Owner confirmation for this OCTO account and session.",
        );
      }
      const now = Date.now();
      ownerDraftStates.set(key, {
        accountId,
        sessionKey: request.sessionKey,
        mailboxId,
        draftId: request.draftId,
        draftVersion: request.draftVersion,
        status: "prepared",
        preparedAtTimestamp: Math.floor(now / 1_000),
        expiresAtMs: now + CONFIRMATION_TTL_MS,
      });
    },
    async sendOwnerDraft(request) {
      validateDeliveryInput(request);
      const key = confirmationKey(accountId, request.sessionKey);
      const confirmation = ownerDraftStates.get(key);
      // Consume confirmed authorization before validation or the network. A
      // timeout may hide a successful submission, so the same confirmation
      // must never be replayable. A premature call must not erase preparation.
      if (confirmation?.status === "confirmed") ownerDraftStates.delete(key);
      const currentOwnerUid = input.getCurrentOwnerUid()?.trim();
      if (
        confirmation?.status !== "confirmed" ||
        confirmation.expiresAtMs <= Date.now() ||
        currentOwnerUid === undefined ||
        confirmation.ownerUid !== currentOwnerUid ||
        confirmation.mailboxId !== request.mailboxId.trim() ||
        confirmation.draftId !== request.draftId ||
        confirmation.draftVersion !== request.draftVersion
      ) {
        throw new Error(
          "No matching exact trusted-owner mail confirmation exists for this OCTO account, session, and Draft.",
        );
      }

      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await fetchImpl(
        `${apiUrl}/v1/bot/agent-mail/drafts/${encodeURIComponent(confirmation.draftId)}/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${botToken}`,
            "Content-Type": "application/json",
            "X-Space-ID": confirmation.spaceId,
          },
          body: JSON.stringify({
            mailboxId: confirmation.mailboxId,
            draftVersion: confirmation.draftVersion,
          }),
          signal,
        },
      );
      const body = await response.text();
      if (!response.ok) {
        const code = readErrorCode(body);
        throw new Error(
          code
            ? `OCTO Agent Mail owner Draft delivery failed: ${code}`
            : `OCTO Agent Mail owner Draft delivery failed (${response.status})`,
        );
      }
      return parseDeliveryResult(body);
    },
  };
}

export function clearOwnerDraftConfirmations(accountId?: string): void {
  if (accountId === undefined) {
    ownerDraftStates.clear();
    recordedConfirmationMessages.clear();
    return;
  }
  const prefix = `${normalizeAccountId(accountId)}\0`;
  for (const key of ownerDraftStates.keys()) {
    if (key.startsWith(prefix)) ownerDraftStates.delete(key);
  }
  for (const key of recordedConfirmationMessages) {
    if (key.startsWith(prefix)) recordedConfirmationMessages.delete(key);
  }
}

function validateDeliveryInput(input: OwnerDraftDeliveryInput): void {
  if (
    input.sessionKey.trim() === "" ||
    input.sessionKey.length > 512 ||
    input.mailboxId.trim() === "" ||
    input.mailboxId.length > 64 ||
    !DRAFT_ID_PATTERN.test(input.draftId) ||
    !Number.isSafeInteger(input.draftVersion) ||
    input.draftVersion <= 0
  ) {
    throw new Error("Invalid OCTO Agent Mail owner Draft delivery request");
  }
}

function parseDeliveryResult(body: string): OwnerDraftDeliveryResult {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("OCTO Agent Mail owner Draft delivery returned invalid JSON");
  }
  if (!isRecord(value) || value["outcome"] !== "accepted") {
    throw new Error("OCTO Agent Mail owner Draft delivery returned an invalid result");
  }
  const messageId = value["messageId"];
  const submissionIds = value["submissionIds"];
  const senderAddress = value["senderAddress"];
  if (
    typeof messageId !== "string" ||
    messageId.trim() === "" ||
    !Array.isArray(submissionIds) ||
    !submissionIds.every((item) => typeof item === "string" || typeof item === "number") ||
    (senderAddress !== undefined && typeof senderAddress !== "string")
  ) {
    throw new Error("OCTO Agent Mail owner Draft delivery returned an invalid result");
  }
  return {
    outcome: "accepted",
    messageId,
    submissionIds: submissionIds.map(String),
    ...(typeof senderAddress === "string" && senderAddress.trim() !== ""
      ? { senderAddress }
      : {}),
  };
}

function readErrorCode(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || !isRecord(value["error"])) return undefined;
    const code = value["error"]["code"];
    return typeof code === "string" && code.trim() !== "" ? code : undefined;
  } catch {
    return undefined;
  }
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [key, value] of ownerDraftStates) {
    if (value.expiresAtMs <= nowMs) {
      ownerDraftStates.delete(key);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
