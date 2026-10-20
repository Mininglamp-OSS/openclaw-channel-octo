import fs from "node:fs";
import path from "node:path";
import { events, selectCards } from "./evidence.mjs";

const marker = process.argv[2];
const sessionKey = process.argv[3];
const targetUid = process.argv[4];
const startedAtMs = Number(process.argv[5]);
const scope = JSON.parse(process.argv[6] ?? "null");
if (!scope?.runId || !scope.requestId || !scope.requestRoot?.startsWith(`/var/lib/octo-host-e2e/runs/${scope.runId}/`)) throw new Error("owned run/request identity required");
const stateRoot = scope.profile;
const requestRoot = scope.requestRoot;
const run = { runId: scope.runId, requestRoot };

if (!marker || !sessionKey || !targetUid || !Number.isFinite(startedAtMs)) {
  throw new Error("usage: inspect.mjs <marker> <sessionKey> <targetUid> <startedAtMs>");
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

// Read only the exact host-derived session; never scan unrelated transcripts.
function transcriptFromSessionStore() {
  try {
    const store = JSON.parse(fs.readFileSync(
      `${stateRoot}/agents/main/sessions/sessions.json`, "utf8"));
    const file = store[sessionKey]?.sessionFile;
    if (typeof file !== "string" || !fs.existsSync(file)) return undefined;
    return { file, rows: readJsonLines(file) };
  } catch {
    return undefined;
  }
}

function findParentTranscript() {
  return transcriptFromSessionStore() ?? { file: undefined, rows: [] };
}

function findChildTrajectory() {
  const dir = `${stateRoot}/agents/main/sessions`;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".trajectory.jsonl"));
  } catch {
    return [];
  }
  for (const name of files) {
    const rows = readJsonLines(path.join(dir, name));
    if (!rows.some((row) => row?.sessionKey?.includes(":subagent:"))) continue;
    if (JSON.stringify(rows).includes(marker)) return rows;
  }
  return [];
}

function readGatewayLogs() {
  let text = "";
  try { text = fs.readFileSync(scope.gatewayLog, "utf8"); } catch {}
  return text.split("\n").filter((line) => {
    let timestamp;
    try { const row = JSON.parse(line); timestamp = row.time ?? row._meta?.date; } catch {}
    timestamp ??= line.match(/\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})/)?.[0];
    return timestamp && Date.parse(timestamp) >= startedAtMs;
  }).join("\n");
}

function readSessionSettings() {
  try {
    const store = JSON.parse(fs.readFileSync(`${stateRoot}/agents/main/sessions/sessions.json`, "utf8"));
    const entry = store[sessionKey] ?? {};
    return {
      thinkingLevel: entry.thinkingLevel,
      reasoningLevel: entry.reasoningLevel,
    };
  } catch {
    return {};
  }
}

async function exactCards() {
  const config = JSON.parse(fs.readFileSync(`${stateRoot}/openclaw.json`, "utf8"));
  const account = Object.values(config.channels?.octo?.accounts ?? {})[0];
  if (!account?.apiUrl || !account?.botToken) throw new Error("private test account missing");
  const response = await fetch(`${account.apiUrl.replace(/\/+$/, "")}/v1/bot/messages/sync`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.botToken}` },
    body: JSON.stringify({ channel_id: targetUid, channel_type: 1, limit: 100, start_message_seq: 0, end_message_seq: 0, pull_mode: 1 }),
  });
  if (!response.ok) throw new Error(`card identity readback failed: ${response.status}`);
  const body = await response.json();
  return selectCards(events(run), { leaseRunId: run.runId, marker, sessionKey, requestId: scope.requestId }, body.messages ?? []);
}

// New hosts persist transcripts in SQLite. Use the public read-only SDK rather
// than assuming JSONL exports exist or reading/changing private DB tables.
const sdk = await import("openclaw/plugin-sdk/session-store-runtime");
const env = { ...process.env, OPENCLAW_STATE_DIR: stateRoot };
const sqlite = typeof sdk.loadTranscriptEventsSync === "function";
const entries = sqlite ? sdk.listSessionEntries({ agentId: "main", env, readOnly: true }) : [];
const current = entries.find((item) => item.sessionKey === sessionKey)?.entry;
const { file, rows: allRows } = sqlite
  ? { file: `sqlite:${current?.sessionId ?? "pending"}`, rows: current ? sdk.loadTranscriptEventsSync({
    agentId: "main", env, sessionKey, sessionId: current.sessionId,
  }) : [] }
  : findParentTranscript();
const rows = allRows.filter((row) => {
  const timestamp = row.timestamp ?? row.message?.timestamp;
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  return ms >= startedAtMs;
});
const trajectoryFile = !sqlite ? file?.replace(/\.jsonl$/, ".trajectory.jsonl") : undefined;
const trajectoryRows = sqlite ? rows : trajectoryFile ? readJsonLines(trajectoryFile) : [];
const spawnedKeys = new Set(rows.filter((r) => r.message?.toolName === "sessions_spawn")
  .map((r) => r.message?.details?.childSessionKey).filter(Boolean));
let childRows = [];
if (sqlite) {
  const rememberedPath = path.join(requestRoot, `${marker}.children.json`);
  let children = [];
  try { children = JSON.parse(fs.readFileSync(rememberedPath, "utf8")); } catch {}
  for (const item of entries) {
    if (item.sessionKey.includes(":subagent:") &&
        (spawnedKeys.has(item.sessionKey) ||
        item.entry.spawnedBy === sessionKey || item.entry.spawnedByKey === sessionKey)) {
      if (!children.some((c) => c.sessionId === item.entry.sessionId)) children.push({ sessionKey: item.sessionKey, sessionId: item.entry.sessionId });
    }
  }
  fs.writeFileSync(rememberedPath, JSON.stringify(children));
  for (const child of children) {
    childRows.push(...sdk.loadTranscriptEventsSync({ agentId: "main", env, ...child }));
  }
} else childRows = findChildTrajectory();
const childTrajectoryText = JSON.stringify(childRows);
const toolCalls = rows.flatMap((row) => {
  if (row.message?.role !== "assistant" || !Array.isArray(row.message.content)) return [];
  return row.message.content
    .filter((part) => part?.type === "toolCall")
    .map((part) => ({ name: part.name, arguments: part.arguments }));
});
const texts = rows.map((row) => ({ role: row.message?.role, text: messageText(row.message) }));
const trajectoryText = JSON.stringify(trajectoryRows);
const gatewayLogs = readGatewayLogs();
const exact = await exactCards();
const cards = exact.cards;
const sessionSettings = sqlite ? { thinkingLevel: current?.thinkingLevel, reasoningLevel: current?.reasoningLevel } : readSessionSettings();

const phaseEvidence = {
  paused: gatewayLogs.includes(`finalized session=${sessionKey} phase=paused`) ||
    gatewayLogs.includes(`transitioned session=${sessionKey} phase=paused`),
  resuming: gatewayLogs.includes(`transitioned session=${sessionKey} phase=resuming`),
  done: gatewayLogs.includes(`transitioned session=${sessionKey} phase=done`),
};

process.stdout.write("OCTO_E2E_EVIDENCE=" + JSON.stringify({
  transcriptFile: file,
  otherFlowCardIds: exact.otherFlowCardIds, requestId: exact.requestId, inputMessageId: exact.inputMessageId, leaseRunId: exact.leaseRunId,
  toolCalls,
  completionEvent: (trajectoryText.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") &&
    trajectoryText.includes(`CHILD_E2E_OK:${marker}`)) || rows.some((r) =>
      r.message?.provenance?.kind === "inter_session" &&
      r.message?.provenance?.sourceTool === "subagent_settle" &&
      spawnedKeys.has(r.message?.provenance?.sourceSessionKey) &&
      messageText(r.message).includes(`CHILD_E2E_OK:${marker}`)),
  childExec: readJsonLines(path.join(requestRoot, "child-tools.jsonl")).some((row) =>
    row.timestampMs >= startedAtMs && spawnedKeys.has(row.sessionKey) && row.toolName === "exec" && row.success === true) ||
    (childTrajectoryText.includes('"toolName":"exec"') || childRows.some((r) => r.message?.role === "toolResult" && r.message?.toolName === "exec")) &&
    (childTrajectoryText.includes('"exitCode":0') ||
      childTrajectoryText.includes('"status":"completed"')),
  followupReply: texts.some(({ role, text }) => role === "assistant" && text.includes(`FOLLOWUP_E2E_OK:${marker}`)),
  parentReply: texts.some(({ role, text }) => role === "assistant" && text.includes(`PARENT_E2E_OK:${marker}`)),
  phases: ["paused", "resuming", "done"].filter((phase) => phaseEvidence[phase]),
  sessionSettings,
  cards,
}) + "\n");
