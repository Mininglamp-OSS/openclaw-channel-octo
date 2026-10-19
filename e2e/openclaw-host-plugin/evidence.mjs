// Test-only causal ledger. No target/time scan can create a successful card.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const idPattern = /^[0-9a-f-]{36}$/i;
export function appendEvent(run, event) {
  fs.mkdirSync(run.requestRoot, { recursive: true });
  fs.appendFileSync(path.join(run.requestRoot, "events.jsonl"), JSON.stringify({ ...event, leaseRunId: run.runId, at: Date.now() }) + "\n", { mode: 0o600 });
}
export function events(run) {
  try { return fs.readFileSync(path.join(run.requestRoot, "events.jsonl"), "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { const e = JSON.parse(line); return e.leaseRunId === run.runId ? [e] : []; } catch { return []; }
  }); } catch { return []; }
}
export function ownerKey(apiUrl, authorization) {
  return createHash("sha256").update(`${apiUrl.replace(/\/+$/, "")}\0${authorization}`).digest("hex");
}
export function reasoningKey(sessionKey, agentRunId) {
  const raw = `${sessionKey}:${agentRunId}`;
  return [...raw].length <= 512 ? raw : `octo-reasoning:sha256:${createHash("sha256").update(raw).digest("hex")}`;
}
export function inputTag(leaseRunId, requestId, messageId) {
  if (!idPattern.test(leaseRunId) || !idPattern.test(requestId) || !/^\d+$/.test(messageId)) throw new Error("invalid injection identity");
  return `OCTO_E2E_INPUT=${leaseRunId}/${requestId}/${messageId}`;
}
export function bindInput(run, prompt, sessionKey, agentRunId) {
  if (typeof prompt !== "string" || !sessionKey || !agentRunId) return;
  const tags = [...new Set(prompt.match(/OCTO_E2E_INPUT=[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d+/gi) ?? [])];
  const input = events(run).filter((e) => e.type === "input" && e.sessionKey === sessionKey && tags.includes(inputTag(run.runId, e.requestId, e.messageId)));
  if (input.length !== 1 || tags.length !== 1) return;
  appendEvent(run, { type: "binding", requestId: input[0].requestId, messageId: input[0].messageId,
    marker: input[0].marker, sessionKey, agentRunId });
}
function identity(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function toolCardId(result) { return identity(result?.details?.message_id ?? result?.details?.messageId); }
export function selectCards(log, { leaseRunId, marker, sessionKey, requestId }, remoteMessages) {
  const input = log.filter((e) => e.leaseRunId === leaseRunId && e.type === "input" && e.marker === marker &&
    e.sessionKey === sessionKey && e.requestId === requestId);
  if (input.length !== 1 || !log.some((e) => e.type === "ack" && e.leaseRunId === leaseRunId && e.requestId === requestId && e.messageId === input[0].messageId)) {
    throw new Error("exact injected request/ACK missing or ambiguous");
  }
  const flowInputs = log.filter((e) => e.type === "input" && e.leaseRunId === leaseRunId && e.marker === marker && e.sessionKey === sessionKey);
  const bindings = log.filter((e) => e.type === "binding" && e.leaseRunId === leaseRunId && e.marker === marker && e.sessionKey === sessionKey &&
    flowInputs.some((i) => i.requestId === e.requestId && i.messageId === e.messageId && log.some((a) => a.type === "ack" && a.requestId === i.requestId && a.messageId === i.messageId && a.leaseRunId === leaseRunId)));
  for (const i of flowInputs) {
    if (new Set(bindings.filter((b) => b.requestId === i.requestId).map((b) => b.agentRunId)).size > 1) throw new Error("one injected input bound to multiple host runs");
  }
  const creates = log.filter((e) => e.leaseRunId === leaseRunId && e.type === "card-created" && e.ok && e.messageId &&
    e.owner === input[0].owner && e.channelId === input[0].channelId && e.channelType === input[0].channelType);
  const cards = [];
  for (const create of creates) {
    let binding;
    const reason = create.payload?.data?.reasoningId;
    if (typeof reason === "string") binding = bindings.find((b) => reasoningKey(b.sessionKey, b.agentRunId) === reason);
    else {
      const receipt = log.find((e) => e.leaseRunId === leaseRunId && e.type === "card-tool" && e.ok && e.messageId === create.messageId &&
        (!e.clientMsgNo || e.clientMsgNo === create.clientMsgNo) && bindings.some((b) => b.agentRunId === e.agentRunId && b.sessionKey === e.sessionKey));
      if (receipt) binding = bindings.find((b) => b.agentRunId === receipt.agentRunId && b.sessionKey === receipt.sessionKey);
    }
    if (!binding) continue;
    const remote = remoteMessages.find((m) => identity(m.message_idstr ?? m.message_id) === create.messageId &&
      (!m.channel_id || m.channel_id === create.channelId) && (!m.channel_type || m.channel_type === create.channelType));
    if (!remote) continue;
    const edits = log.filter((e) => e.leaseRunId === leaseRunId && e.type === "card-edited" && e.ok &&
      e.messageId === create.messageId && e.owner === create.owner &&
      (!reason || e.envelope?.data?.reasoningId === reason));
    const last = edits.at(-1)?.envelope ?? create.payload;
    if (cards.some((c) => c.messageId === create.messageId)) continue;
    cards.push({ messageId: create.messageId, timestampMs: create.at,
      plain: typeof last.plain === "string" ? last.plain : "", plainSource: edits.length ? "accepted-edit" : "original-message",
      ...(last.template_ref ? { templateRef: last.template_ref } : {}), ...(last.state ? { state: last.state } : {}),
      ...(last.data ? { data: last.data } : {}), ...(Number.isSafeInteger(last.card_seq) ? { cardSeq: last.card_seq } : {}),
      ...(edits.length ? { transient: last.transient === true } : {}),
      editCardSeqs: edits.map((e) => e.envelope.card_seq).filter(Number.isSafeInteger),
      correlation: { leaseRunId, marker, sessionKey, requestId: binding.requestId, inputMessageId: binding.messageId, agentRunId: binding.agentRunId },
    });
  }
  return { cards: cards.filter((c) => c.correlation.requestId === requestId),
    otherFlowCardIds: cards.filter((c) => c.correlation.requestId !== requestId).map((c) => c.messageId),
    inputMessageId: input[0].messageId, requestId, leaseRunId };
}
