import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendEvent, bindInput, events, inputTag, ownerKey, reasoningKey, selectCards } from "../e2e/openclaw-host-plugin/evidence.mjs";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(state = "error") {
  const runId = randomUUID(), marker = randomUUID(), requestId = randomUUID();
  const sessionKey = "agent:main:octo:scope:direct:target", agentRunId = randomUUID();
  const query = { leaseRunId: runId, marker, sessionKey, requestId };
  const owner = ownerKey("https://api.example", "Bearer synthetic");
  const input = { type: "input", leaseRunId: runId, marker, sessionKey, requestId, messageId: "100", channelId: "target", channelType: 1, owner };
  const log = [input, { type: "ack", leaseRunId: runId, requestId, messageId: "100" },
    { type: "binding", leaseRunId: runId, marker, sessionKey, requestId, messageId: "100", agentRunId },
    { type: "card-created", leaseRunId: runId, owner, channelId: "target", channelType: 1, messageId: "own", clientMsgNo: "c-own", ok: true,
      payload: { type: 17, state, plain: state, data: { reasoningId: reasoningKey(sessionKey, agentRunId) } } }];
  return { runId, marker, requestId, sessionKey, agentRunId, query, owner, input, log,
    remote: [{ message_id: "own", channel_id: "target", channel_type: 1 }] };
}
describe("exact injected-request card evidence", () => {
  it("keeps own error when a newer completed card for the same target exists", () => {
    const f = fixture();
    f.log.push({ ...f.log[3], messageId: "foreign", payload: { type: 17, state: "completed", plain: "exec message completed",
      data: { reasoningId: reasoningKey(f.sessionKey, randomUUID()) } } });
    f.remote.push({ message_id: "foreign", channel_id: "target", channel_type: 1 });
    const result = selectCards(f.log, f.query, f.remote);
    expect(result.cards.map((c: {messageId: string}) => c.messageId)).toEqual(["own"]);
    expect(result.cards[0].state).toBe("error");
  });
  it("foreign completed cards cannot supply an absent own card", () => {
    const f = fixture(); f.log.pop();
    f.remote.push({ message_id: "foreign", channel_id: "target", channel_type: 1 });
    expect(selectCards(f.log, f.query, f.remote).cards).toEqual([]);
  });
  it.each(["owner", "channelId", "channelType", "reasoningId", "leaseRunId"])("rejects wrong %s despite the same time/target/card shape", (field) => {
    const f = fixture("completed");
    if (field === "reasoningId") f.log[3].payload.data.reasoningId = reasoningKey("other-session", f.agentRunId);
    else (f.log[3] as Record<string, unknown>)[field] = field === "channelType" ? 2 : "foreign";
    expect(selectCards(f.log, f.query, f.remote).cards).toEqual([]);
  });
  it("rejects missing or wrong ACK and ambiguous host run binding", () => {
    const f = fixture();
    expect(() => selectCards(f.log.filter((e) => e.type !== "ack"), f.query, f.remote)).toThrow(/ACK/);
    expect(() => selectCards(f.log, { ...f.query, requestId: randomUUID() }, f.remote)).toThrow(/request/);
    f.log.push({ ...f.log[2], agentRunId: randomUUID() });
    expect(() => selectCards(f.log, f.query, f.remote)).toThrow(/multiple host runs/);
  });
  it("a foreign accepted edit cannot turn the owned card completed", () => {
    const f = fixture();
    f.log.push({ type: "card-edited", leaseRunId: f.runId, owner: f.owner, messageId: "foreign", ok: true,
      envelope: { state: "completed", data: f.log[3].payload.data, card_seq: 3 } });
    f.log.push({ type: "card-edited", leaseRunId: f.runId, owner: "foreign-auth", messageId: "own", ok: true,
      envelope: { state: "completed", data: f.log[3].payload.data, card_seq: 4 } });
    expect(selectCards(f.log, f.query, f.remote).cards[0].state).toBe("error");
  });
  it("accepts only exact owned ID readback and edits, retaining request/session/run identity", () => {
    const f = fixture();
    f.log.push({ type: "card-edited", leaseRunId: f.runId, owner: f.owner, messageId: "own", ok: true,
      envelope: { state: "completed", data: f.log[3].payload.data, card_seq: 1 } });
    const card = selectCards(f.log, f.query, f.remote).cards[0];
    expect(card.state).toBe("completed"); expect(card.editCardSeqs).toEqual([1]);
    expect(card.correlation).toMatchObject({ ...f.query, inputMessageId: "100", agentRunId: f.agentRunId });
    expect(selectCards(f.log, f.query, []).cards).toEqual([]);
  });
  it("display cards need both a host tool receipt and exact HTTP create ID/client nonce", () => {
    const f = fixture(); f.log[3].payload = { type: 17, state: "completed", plain: "display" } as never;
    expect(selectCards(f.log, f.query, f.remote).cards).toEqual([]);
    f.log.push({ type: "card-tool", leaseRunId: f.runId, sessionKey: f.sessionKey, agentRunId: f.agentRunId,
      messageId: "own", clientMsgNo: "wrong", ok: true });
    expect(selectCards(f.log, f.query, f.remote).cards).toEqual([]);
    f.log.at(-1)!.clientMsgNo = "c-own";
    expect(selectCards(f.log, f.query, f.remote).cards[0].messageId).toBe("own");
  });
  it("a fully bound different input in the same flow cannot replace an absent primary card", () => {
    const f = fixture(); f.log.pop(); const followup = randomUUID(), otherRun = randomUUID();
    f.log.push({ ...f.input, requestId: followup, messageId: "101", kind: "followup" },
      { type: "ack", leaseRunId: f.runId, requestId: followup, messageId: "101" },
      { type: "binding", leaseRunId: f.runId, marker: f.marker, sessionKey: f.sessionKey, requestId: followup, messageId: "101", agentRunId: otherRun },
      { type: "card-created", leaseRunId: f.runId, owner: f.owner, channelId: "target", channelType: 1, messageId: "other", ok: true,
        payload: { type: 17, state: "completed", data: { reasoningId: reasoningKey(f.sessionKey, otherRun) } } });
    f.remote.push({ message_id: "other", channel_id: "target", channel_type: 1 });
    const result = selectCards(f.log, f.query, f.remote);
    expect(result.cards).toEqual([]); expect(result.otherFlowCardIds).toEqual(["other"]);
  });
  it("binds only a sent exact input nonce in the expected session", () => {
    const f = fixture(); const requestRoot = mkdtempSync(path.join(tmpdir(), "octo-evidence-")); dirs.push(requestRoot);
    const run = { runId: f.runId, requestRoot }; appendEvent(run, f.input);
    const tag = inputTag(f.runId, f.requestId, "100");
    bindInput(run, tag, "other-session", f.agentRunId);
    bindInput(run, inputTag(randomUUID(), f.requestId, "100"), f.sessionKey, f.agentRunId);
    expect(events(run).filter((e: {type: string}) => e.type === "binding")).toEqual([]);
    bindInput(run, tag, f.sessionKey, f.agentRunId);
    expect(events(run).filter((e: {type: string}) => e.type === "binding")).toHaveLength(1);
  });
});
