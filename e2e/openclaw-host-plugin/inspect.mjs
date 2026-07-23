import fs from "node:fs";
import path from "node:path";

const marker = process.argv[2];
const sessionKey = process.argv[3];
const targetUid = process.argv[4];
const startedAtMs = Number(process.argv[5]);

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

function findParentTranscript() {
  const dir = "/root/.openclaw-dev/agents/main/sessions";
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) =>
      name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl"));
  } catch {
    return { file: undefined, rows: [] };
  }
  for (const name of files) {
    const file = path.join(dir, name);
    const rows = readJsonLines(file);
    const serialized = JSON.stringify(rows);
    if (serialized.includes(marker) && serialized.includes("sessions_yield")) return { file, rows };
  }
  return { file: undefined, rows: [] };
}

function findChildTrajectory() {
  const dir = "/root/.openclaw-dev/agents/main/sessions";
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
  const candidates = [];
  for (const dir of ["/tmp/openclaw", "/tmp"]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".log")) continue;
        if (dir === "/tmp" && !name.startsWith("gw")) continue;
        candidates.push(path.join(dir, name));
      }
    } catch {
      // Optional log location.
    }
  }
  return candidates.map((file) => {
    try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
  }).join("\n");
}

function readSessionSettings() {
  try {
    const store = JSON.parse(fs.readFileSync("/root/.openclaw-dev/agents/main/sessions/sessions.json", "utf8"));
    const entry = store[sessionKey] ?? {};
    return {
      thinkingLevel: entry.thinkingLevel,
      reasoningLevel: entry.reasoningLevel,
    };
  } catch {
    return {};
  }
}

function latestAcceptedEdit(messageId) {
  const edits = readJsonLines("/tmp/octo-host-e2e/card-edits.jsonl")
    .filter((row) => row?.ok === true && row?.messageId === messageId &&
      Number(row?.timestampMs ?? 0) >= startedAtMs - 5_000)
    .sort((a, b) => Number(a.timestampMs ?? 0) - Number(b.timestampMs ?? 0));
  return edits.at(-1);
}

async function recentCards() {
  const config = JSON.parse(fs.readFileSync("/root/.openclaw-dev/openclaw.json", "utf8"));
  const account = Object.values(config.channels?.octo?.accounts ?? {})[0];
  if (!account?.apiUrl || !account?.botToken) return [];
  const response = await fetch(`${account.apiUrl.replace(/\/+$/, "")}/v1/bot/messages/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.botToken}`,
    },
    body: JSON.stringify({
      channel_id: targetUid,
      channel_type: 1,
      limit: 100,
      start_message_seq: 0,
      end_message_seq: 0,
      pull_mode: 1,
    }),
  });
  if (!response.ok) return [];
  const body = await response.json();
  return (body.messages ?? []).flatMap((message) => {
    try {
      const payload = JSON.parse(Buffer.from(message.payload, "base64").toString("utf8"));
      const timestampMs = Number(message.timestamp ?? 0) * 1000;
      if (payload.type !== 17 || timestampMs < startedAtMs - 5_000) return [];
      const messageId = String(message.message_idstr ?? message.message_id ?? "");
      const edit = latestAcceptedEdit(messageId);
      return [{
        messageId,
        timestampMs,
        plain: typeof edit?.plain === "string"
          ? edit.plain
          : typeof payload.plain === "string" ? payload.plain : "",
        plainSource: edit ? "accepted-edit" : "original-message",
      }];
    } catch {
      return [];
    }
  });
}

const { file, rows } = findParentTranscript();
const trajectoryFile = file?.replace(/\.jsonl$/, ".trajectory.jsonl");
const trajectoryRows = trajectoryFile ? readJsonLines(trajectoryFile) : [];
const childTrajectoryText = JSON.stringify(findChildTrajectory());
const toolCalls = rows.flatMap((row) => {
  if (row.message?.role !== "assistant" || !Array.isArray(row.message.content)) return [];
  return row.message.content
    .filter((part) => part?.type === "toolCall")
    .map((part) => ({ name: part.name, arguments: part.arguments }));
});
const texts = rows.map((row) => ({ role: row.message?.role, text: messageText(row.message) }));
const trajectoryText = JSON.stringify(trajectoryRows);
const gatewayLogs = readGatewayLogs();
const cards = await recentCards();
const sessionSettings = readSessionSettings();

const phaseEvidence = {
  paused: gatewayLogs.includes(`finalized session=${sessionKey} phase=paused`) ||
    gatewayLogs.includes(`transitioned session=${sessionKey} phase=paused`),
  resuming: gatewayLogs.includes(`transitioned session=${sessionKey} phase=resuming`),
  done: gatewayLogs.includes(`transitioned session=${sessionKey} phase=done`),
};

console.log(JSON.stringify({
  transcriptFile: file,
  toolCalls,
  completionEvent: trajectoryText.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") &&
    trajectoryText.includes(`CHILD_E2E_OK:${marker}`),
  childExec: childTrajectoryText.includes('"toolName":"exec"') &&
    (childTrajectoryText.includes('"exitCode":0') ||
      childTrajectoryText.includes('"status":"completed"')),
  followupReply: texts.some(({ role, text }) => role === "assistant" && text.includes(`FOLLOWUP_E2E_OK:${marker}`)),
  parentReply: texts.some(({ role, text }) => role === "assistant" && text.includes(`PARENT_E2E_OK:${marker}`)),
  phases: ["paused", "resuming", "done"].filter((phase) => phaseEvidence[phase]),
  sessionSettings,
  cards,
}));
