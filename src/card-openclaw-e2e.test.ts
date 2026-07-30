/**
 * Real OpenClaw host E2E (container + real Octo server), explicitly gated.
 *
 * The companion plugin under e2e/openclaw-host-plugin injects a synthetic
 * Octo DM into handleInboundMessage. A loopback scripted model makes tool
 * choices deterministic; OpenClaw tool/subagent execution, sessions_yield,
 * protected completion, lifecycle hooks, and Octo send/edit HTTP calls are real.
 *
 * Required setup is automated by scripts/run-openclaw-card-e2e.mjs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const enabled = process.env.OCTO_OPENCLAW_E2E === "1";
const suite = enabled ? describe : describe.skip;

type Evidence = {
  transcriptFile?: string;
  toolCalls: Array<{ name?: string; arguments?: Record<string, unknown> }>;
  completionEvent: boolean;
  childExec: boolean;
  followupReply: boolean;
  parentReply: boolean;
  phases: string[];
  sessionSettings: { thinkingLevel?: string; reasoningLevel?: string };
  cards: Array<{
    messageId: string;
    timestampMs: number;
    plain: string;
    plainSource?: "original-message" | "accepted-edit";
    templateRef?: { id: string; version: string };
    state?: string;
    data?: Record<string, unknown>;
    cardSeq?: number;
    transient?: boolean;
    editCardSeqs: number[];
  }>;
};

type CardEvidence = Evidence["cards"][number];

function cardText(card: CardEvidence | undefined): string {
  if (!card) return "";
  if (card.plain) return card.plain;
  const data = card.data;
  if (!data) return "";
  const phases = Array.isArray(data.phases) ? data.phases : [];
  return [
    data.title,
    data.statusLabel,
    data.timerText,
    data.progressText,
    data.errorTitle,
    data.errorMessage,
    ...phases.flatMap((phase) => {
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) return [];
      const record = phase as Record<string, unknown>;
      const actions = Array.isArray(record.actions) ? record.actions : [];
      return [
        record.thought,
        ...actions.flatMap((action) => {
          if (!action || typeof action !== "object" || Array.isArray(action)) return [];
          const actionRecord = action as Record<string, unknown>;
          return [actionRecord.tool, actionRecord.detail];
        }),
      ];
    }),
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ");
}

function expectStrictlyIncreasing(values: number[]): void {
  expect(values.length).toBeGreaterThan(0);
  for (let index = 1; index < values.length; index++) {
    expect(values[index]).toBeGreaterThan(values[index - 1]!);
  }
}

type BridgeResult = {
  ok?: boolean;
  sessionKey?: string;
  kind?: string;
  error?: string;
};

const container = process.env.OCTO_E2E_CONTAINER ?? "ocprobe";
const targetUid = process.env.OCTO_E2E_TARGET_UID ?? "";

async function dockerExec(args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["exec", ...args], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function callBridge(params: Record<string, unknown>): Promise<BridgeResult> {
  const requestId = `${String(params.kind)}-${String(params.marker)}`;
  const requestPath = `/tmp/octo-host-e2e/${requestId}.request.json`;
  const resultPath = `/tmp/octo-host-e2e/${requestId}.result.json`;
  const encoded = Buffer.from(JSON.stringify(params)).toString("base64");
  await dockerExec([
    container,
    "node", "-e",
    "const fs=require('fs');const p=process.argv[1];fs.mkdirSync('/tmp/octo-host-e2e',{recursive:true});fs.writeFileSync(p+'.tmp',Buffer.from(process.argv[2],'base64'));fs.renameSync(p+'.tmp',p)",
    requestPath,
    encoded,
  ]);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let output: string;
    try {
      output = await dockerExec([
        container,
        "node", "-e",
        "const fs=require('fs');const p=process.argv[1];if(!fs.existsSync(p))process.exit(2);process.stdout.write(fs.readFileSync(p,'utf8'))",
        resultPath,
      ]);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    const result = JSON.parse(output) as BridgeResult;
    expect(result.ok, result.error).toBe(true);
    expect(result.sessionKey).toBe(params.sessionKey);
    return result;
  }
  throw new Error(`bridge request timed out: ${requestId}`);
}

async function inspect(marker: string, sessionKey: string, startedAtMs: number): Promise<Evidence> {
  const output = await dockerExec([
    container,
    "node", "/root/.openclaw-dev/extensions/octo-host-e2e/inspect.mjs",
    marker, sessionKey, targetUid, String(startedAtMs),
  ], 30_000);
  return JSON.parse(output) as Evidence;
}

async function waitForEvidence(
  marker: string,
  sessionKey: string,
  startedAtMs: number,
  predicate: (evidence: Evidence) => boolean,
  timeoutMs: number,
): Promise<Evidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: Evidence | undefined;
  while (Date.now() < deadline) {
    latest = await inspect(marker, sessionKey, startedAtMs);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`OpenClaw E2E timed out; latest evidence=${JSON.stringify(latest)}`);
}

type LifecycleFlowOptions = {
  childDelaySeconds: number;
  pausedCheckpointDelayMs?: number;
};

async function runLifecycleFlow({
  childDelaySeconds,
  pausedCheckpointDelayMs,
}: LifecycleFlowOptions): Promise<void> {
  expect(targetUid, "OCTO_E2E_TARGET_UID is required").not.toBe("");
  const marker = randomUUID();
  const sessionKey = `agent:main:octo-host-e2e:${marker}`;
  await callBridge({
    kind: "configure-reasoning",
    marker,
    targetUid,
    sessionKey,
  });
  const startedAtMs = Date.now();

  await callBridge({
    kind: "spawn",
    marker,
    targetUid,
    sessionKey,
    // The child performs a foreground exec with a longer yield/timeout,
    // leaving enough room for the unrelated follow-up before completion.
    childDelaySeconds,
  });

  const paused = await waitForEvidence(
    marker,
    sessionKey,
    startedAtMs,
    (evidence) => evidence.phases.includes("paused") && evidence.cards.length === 1,
    60_000,
  );
  expect(paused.cards).toHaveLength(1);
  expect(paused.sessionSettings).toMatchObject({
    reasoningLevel: "stream",
  });

  // A normal user run starts on the same session while the child is still
  // sleeping. It must not claim or finish the retained background-task card.
  await callBridge({ kind: "followup", marker, targetUid, sessionKey });
  const afterFollowup = await waitForEvidence(
    marker,
    sessionKey,
    startedAtMs,
    (evidence) => evidence.followupReply,
    15_000,
  );
  expect(afterFollowup.followupReply).toBe(true);
  expect(afterFollowup.completionEvent).toBe(false);
  expect(afterFollowup.phases).toEqual(["paused"]);
  expect(afterFollowup.cards).toHaveLength(1);
  expect(afterFollowup.cards[0]?.messageId).toBe(paused.cards[0]?.messageId);

  if (pausedCheckpointDelayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, pausedCheckpointDelayMs));
    const checkpoint = await inspect(marker, sessionKey, startedAtMs);
    expect(checkpoint.completionEvent).toBe(false);
    expect(checkpoint.phases).toEqual(["paused"]);
    expect(checkpoint.cards).toHaveLength(1);
    expect(checkpoint.cards[0]?.messageId).toBe(paused.cards[0]?.messageId);
    expect(checkpoint.cards[0]?.plainSource).toBe("accepted-edit");
    expect(cardText(checkpoint.cards[0])).toContain("Waiting for subtask...");
    // Paused cards may remain visible for up to the one-hour retention window, so the
    // waiting frame must be durable and available to late-joining clients.
    expect(checkpoint.cards[0]?.transient).toBe(false);
  }

  const completed = await waitForEvidence(
    marker,
    sessionKey,
    startedAtMs,
    (evidence) => evidence.completionEvent && evidence.parentReply &&
      evidence.phases.includes("resuming") && evidence.phases.includes("done") &&
      evidence.cards.length === 1,
    120_000,
  );

  const names = completed.toolCalls.map((call) => call.name);
  expect(names.filter((name) => name === "sessions_spawn")).toHaveLength(1);
  expect(names.filter((name) => name === "sessions_yield")).toHaveLength(1);
  expect(names).not.toContain("sessions_list");
  expect(names).not.toContain("sessions_history");
  const spawn = completed.toolCalls.find((call) => call.name === "sessions_spawn");
  expect(spawn?.arguments).toMatchObject({
    runtime: "subagent",
    mode: "run",
    context: "isolated",
    model: "octo-e2e/scripted",
  });
  const exec = completed.toolCalls.find((call) => call.name === "exec");
  expect(exec?.arguments).toMatchObject({
    command: "printf OCTO_TOOL_E2E_OK",
  });
  expect(completed.cards).toHaveLength(1);
  expect(completed.cards[0]?.messageId).toBe(paused.cards[0]?.messageId);
  expect(completed.cards[0]?.templateRef).toEqual({ id: "ai.reasoning-process", version: "0.2.0" });
  expect(completed.cards[0]?.state).toBe("completed");
  expect(completed.cards[0]?.transient).toBe(false);
  expectStrictlyIncreasing(completed.cards[0]?.editCardSeqs ?? []);
  expect(cardText(completed.cards[0])).toContain("Visible reasoning checkpoint.");
  // The visible card must contain both the allowlisted input summary (`printf`)
  // and the structured output summary (`exit 0`) from the same real tool call.
  expect(cardText(completed.cards[0])).toContain("exec · printf · exit 0");
  if (pausedCheckpointDelayMs !== undefined) {
    expect(completed.cards[0]?.plainSource).toBe("accepted-edit");
    const text = cardText(completed.cards[0]);
    const waitDuration = text.match(/Subtask returned · ([\d.]+)s/)?.[1];
    expect(waitDuration, text).toBeDefined();
    expect(Number(waitDuration)).toBeGreaterThanOrEqual(pausedCheckpointDelayMs / 1_000);
  }
  expect(completed.phases).toEqual(["paused", "resuming", "done"]);
  expect(completed.childExec).toBe(true);
}

suite("OpenClaw sessions_spawn + sessions_yield card lifecycle E2E", () => {
  it("keeps the paused card through an unrelated run, then resumes and completes it", async () => {
    await runLifecycleFlow({
      childDelaySeconds: 10,
    });
  }, 210_000);

  it("keeps the same paused card while a subagent runs longer than one minute", async () => {
    await runLifecycleFlow({
      childDelaySeconds: 75,
      pausedCheckpointDelayMs: 60_000,
    });
  }, 240_000);
});

suite("OpenClaw realistic filesystem tool workflow E2E", () => {
  it("reads an input file, writes a report, and verifies it with exec", async () => {
    expect(targetUid, "OCTO_E2E_TARGET_UID is required").not.toBe("");
    const marker = randomUUID();
    const sessionKey = `agent:main:octo-host-e2e:${marker}`;
    const workDir = `/tmp/octo-realistic-e2e/${marker}`;
    const inputPath = `${workDir}/input.txt`;
    const reportPath = `${workDir}/report.txt`;

    await dockerExec([
      container,
      "node", "-e",
      "const fs=require('fs'),path=require('path'),p=process.argv[1];fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,process.argv[2])",
      inputPath,
      "alpha=7\n",
    ]);

    try {
      await callBridge({ kind: "configure-reasoning", marker, targetUid, sessionKey });
      const startedAtMs = Date.now();
      const accepted = await callBridge({ kind: "file-tools", marker, targetUid, sessionKey });
      expect(accepted.kind).toBe("file-tools");

      const completed = await waitForEvidence(
        marker,
        sessionKey,
        startedAtMs,
        (evidence) => evidence.cards.some((card) =>
          cardText(card).includes("exec · wc · exit 0")),
        60_000,
      );
      const names = completed.toolCalls.map((call) => call.name);
      expect(names).toEqual(["read", "write", "exec"]);
      expect(completed.toolCalls[0]?.arguments).toMatchObject({ path: inputPath });
      expect(completed.toolCalls[1]?.arguments).toMatchObject({
        path: reportPath,
        content: "Processed: alpha=7\n",
      });
      expect(completed.toolCalls[2]?.arguments).toMatchObject({
        command: `wc -c ${reportPath}`,
      });

      const report = await dockerExec([
        container,
        "node", "-e",
        "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
        reportPath,
      ]);
      expect(report).toBe("Processed: alpha=7\n");
      expect(completed.cards).toHaveLength(1);
      const text = cardText(completed.cards[0]);
      expect(completed.cards[0]?.templateRef).toEqual({ id: "ai.reasoning-process", version: "0.2.0" });
      expect(completed.cards[0]?.state).toBe("completed");
      expect(completed.cards[0]?.transient).toBe(false);
      expectStrictlyIncreasing(completed.cards[0]?.editCardSeqs ?? []);
      expect(text).toContain("I’ll inspect the source file before making changes.");
      expect(text).toContain("The input is valid; I’ll write the derived report.");
      expect(text).toContain("The report is written; I’ll verify its size with a command.");
      expect(text).toContain("read");
      expect(text).toContain("input.txt");
      expect(text).toContain("write");
      expect(text).toContain("report.txt");
      expect(text).toContain("exec · wc · exit 0");
    } finally {
      await dockerExec([
        container,
        "node", "-e",
        "require('fs').rmSync(process.argv[1],{recursive:true,force:true})",
        workDir,
      ]);
    }
  }, 120_000);
});
