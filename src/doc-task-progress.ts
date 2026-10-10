import { isBlockedDocTaskTool } from './doc-task-tool-policy.js';
import { OctoApiError, OctoApiProtocolError } from './api-error.js';
import { publicToolContent, publicToolError, toolResultContent, type DocTaskEvent, type PublicToolContent } from './doc-task-events.js';
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface DocTaskStep {
  id: string; tool: string; state: "running" | "finished" | "failed" | "unknown";
  startedAt: number; finishedAt?: number; durationMs?: number; exitCode?: number;
}
export interface DocTaskProgress {
  attemptId: string; sequence: number;
  eventCount?: number; detailsTruncated?: boolean;
  state: "waiting" | "running" | "finished" | "failed" | "unknown";
  phase: "received" | "model" | "tool" | "ended";
  steps: DocTaskStep[]; omittedSteps: number; replyDelivered: boolean;
  errorCode?: "dispatch_failed" | "delivery_failed" | "permission_denied" | "interrupted";
}
type Context = { sessionKey?: string; runId?: string };
type Entry = { owner?: string; tracker: DocTaskTracker };
const KEY = Symbol.for("openclaw.octo.doc-task-progress.v1");
// Channel dispatch and agent hooks can load in separate VM globals in one host.
// Share ownership on the Node process, as the interactive-card tracker does.
const sharedProcess = process as typeof process & { [KEY]?: Map<string, Entry> };
const entries = sharedProcess[KEY] ??= new Map<string, Entry>();
const safeName = (name: unknown): string => typeof name === "string" && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(name) ? name : "tool";

/** Snapshots stay small; sanitized tool details travel as immutable event batches. */
export class DocTaskTracker {
  private value: DocTaskProgress = {
    attemptId: randomUUID(), sequence: 0, state: "waiting", phase: "received",
    steps: [], omittedSteps: 0, replyDelivered: false, eventCount: 0, detailsTruncated: false,
  };
  private calls = new Map<string, DocTaskStep>();
  private counter = 0;
  private events: DocTaskEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private sending?: Promise<void>;
  private pending?: DocTaskProgress;
  private stopped = false;
  private transport = new AbortController();
  private retryAt = 0;
  private executionFailed = false;
  private interrupted = false;
  constructor(private send: (value: DocTaskProgress, events?: DocTaskEvent[], signal?: AbortSignal) => Promise<void>, private warn?: (error?: unknown) => void) {
    this.flush();
    // Receipt remains live while waiting in the per-document execution queue.
    this.heartbeat = setInterval(() => this.flush(), 10_000);
    this.heartbeat.unref?.();
  }
  attach(sessionKey: string): () => void {
    const entry: Entry = { tracker: this };
    entries.set(sessionKey, entry);
    return () => { if (entries.get(sessionKey) === entry) entries.delete(sessionKey); };
  }
  activity(phase: "model" | "tool"): void {
    if (this.stopped) return;
    this.value.state = "running";
    this.value.phase = phase;
    this.schedule();
  }
  toolStart(event: { toolName?: unknown; toolCallId?: string; params?: unknown }): void {
    if (this.stopped || !event.toolCallId || this.calls.has(event.toolCallId)) return;
    this.activity("tool");
    const step: DocTaskStep = { id: "call-" + (++this.counter), tool: safeName(event.toolName), state: "running", startedAt: Date.now() };
    this.calls.set(event.toolCallId, step);
    this.value.steps.push(step);
    this.record(step, "tool_use", publicToolContent(event.params));
    if (this.value.steps.length > 100) {
      const removed = this.value.steps.shift();
      for (const [key, value] of this.calls) if (value === removed) this.calls.delete(key);
      this.value.omittedSteps++;
    }
  }
  toolEnd(event: { toolCallId?: string; error?: unknown; durationMs?: number; result?: unknown }): void {
    if (this.stopped || !event.toolCallId) return;
    const step = this.calls.get(event.toolCallId);
    if (!step || step.state !== "running") return;
    const result = toolResultContent(event.result, step.tool);
    const { exitCode } = result;
    step.state = event.error || result.isError || (exitCode !== undefined && exitCode !== 0) ? "failed" : "finished";
    step.finishedAt = Math.max(step.startedAt, Date.now());
    step.durationMs = typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0
      ? Math.min(604_800_000, Math.round(event.durationMs)) : step.finishedAt - step.startedAt;
    if (exitCode !== undefined) step.exitCode = exitCode;
    if (event.result !== undefined) this.record(step, "tool_result", result.detail);
    if (event.error) this.record(step, "error", publicToolError(event.error));
    this.schedule();
  }
  private record(step: DocTaskStep, type: DocTaskEvent['type'], content: PublicToolContent): void {
    if ((this.value.eventCount ?? 0) >= 1000) { this.value.detailsTruncated = true; return; }
    this.events.push({ seq: ++this.value.eventCount!, stepId: step.id, tool: step.tool, type,
      ...content, at: Date.now(), failed: step.state === 'failed' });
  }
  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 250);
    this.timer.unref?.();
  }
  private flush(): void {
    this.pending = structuredClone({ ...this.value, sequence: ++this.value.sequence });
    this.drain();
  }
  // Abort both real HTTP requests and local waiting, even if an injected sender
  // ignores cancellation. No retry or batch may start after the terminal budget.
  private abortable<T>(work: () => Promise<T>): Promise<T> {
    const { signal } = this.transport;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return work(); })
        .then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
  private async waitForRetry(): Promise<void> {
    while (this.retryAt > Date.now()) {
      // Node clamps larger delays to 1ms. Chunk long hints without shortening them.
      const delay = Math.min(this.retryAt - Date.now(), 2_147_483_647);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await this.abortable(() => new Promise<void>(resolve => { timer = setTimeout(resolve, delay); })); }
      finally { clearTimeout(timer); }
    }
  }
  private drain(): void {
    if (this.sending || !this.pending || this.transport.signal.aborted) return;
    this.sending = Promise.resolve().then(async () => {
      while (this.pending && !this.transport.signal.aborted) {
        const snapshot = this.pending;
        this.pending = undefined;
        // Keep immutable unacknowledged events. Re-read pending between batches
        // so a terminal receipt is not stuck behind the old snapshot's backlog.
        const batch = this.events.filter(e => e.seq <= (snapshot.eventCount ?? 0)).slice(0, 10);
        let delivered = false;
        for (let attempt = 0; attempt < 3 && !delivered && !this.transport.signal.aborted; attempt++) {
          await this.waitForRetry();
          try {
            await this.abortable(() => this.send(snapshot, batch, this.transport.signal));
            delivered = true;
          } catch (error) {
            if (this.transport.signal.aborted) break;
            try { this.warn?.(error); } catch { /* Evidence failure cannot break the task. */ }
            if (error instanceof OctoApiProtocolError || (error instanceof OctoApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)) {
              this.transport.abort(); // Invalid/missing/forbidden task cannot recover through snapshot retries.
              break;
            }
            // Shared across snapshots: coalescing must not reset a server's hint.
            const hint = error instanceof OctoApiError && error.status === 429 ? error.retryAfterMs : 0;
            this.retryAt = Date.now() + Math.max(1000 * 2 ** attempt, hint);
          }
        }
        if (delivered) {
          this.events.splice(0, batch.length);
          if (!this.pending && this.events.some(e => e.seq <= (snapshot.eventCount ?? 0))) this.pending = snapshot;
        }
      }
    }).catch(() => { /* Aggregate cancellation ends best-effort reporting. */ })
      .finally(() => { this.sending = undefined; this.drain(); });
  }
  runEnded(failed: boolean, interrupted = false): void {
    this.executionFailed ||= failed;
    this.interrupted ||= interrupted;
  }
  async finish(report: { finalDelivered: boolean; failed?: boolean; interrupted?: boolean; permissionDenied?: boolean }): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.value.replyDelivered = report.finalDelivered;
    // A turn/provider can fail after the answer was posted (or recover in a
    // later turn). Only actual interruption can override that delivery fact.
    const interrupted = report.interrupted || this.interrupted;
    const failed = !report.finalDelivered && (report.failed || this.executionFailed || report.permissionDenied);
    this.value.state = interrupted ? "unknown" : report.finalDelivered ? "finished" : failed ? "failed" : "unknown";
    this.value.phase = "ended";
    if (interrupted) this.value.errorCode = "interrupted";
    else if (failed) this.value.errorCode = report.permissionDenied ? "permission_denied" : "dispatch_failed";
    else if (!report.finalDelivered) this.value.errorCode = "delivery_failed";
    for (const step of this.value.steps) if (step.state === "running") step.state = "unknown";
    // Bound the entire terminal drain, not each of up to 100 event batches.
    // Preserve eventCount on cutoff: an incomplete upload must not look complete.
    const deadline = setTimeout(() => {
      try { this.warn?.(); } catch { /* Logging cannot extend the deadline. */ }
      this.transport.abort();
    }, 5000);
    this.flush();
    try { while (this.sending) await this.sending; }
    finally {
      clearTimeout(deadline);
      this.transport.abort();
      this.pending = undefined;
      this.events = [];
    }
  }
}

export function bindDocTaskRun(sessionKey?: string, runId?: string): void {
  if (!sessionKey || !runId) return;
  const entry = entries.get(sessionKey);
  if (entry && !entry.owner) entry.owner = runId;
}
function owned(ctx: unknown): DocTaskTracker | undefined {
  const context = ctx as Context | undefined;
  if (!context?.sessionKey || !context.runId) return;
  const entry = entries.get(context.sessionKey);
  return entry?.owner === context.runId ? entry.tracker : undefined;
}

export function registerDocTaskProgress(api: OpenClawPluginApi): void {
  api.on("before_agent_run", (_event, ctx) => {
    bindDocTaskRun(ctx.sessionKey, ctx.runId);
    return { outcome: "pass" } as const;
  });
  api.on("model_call_started", (_event, ctx) => { owned(ctx)?.activity("model"); });
  api.on("before_tool_call", (event, ctx) => {
    if (!isBlockedDocTaskTool(ctx.sessionKey, event.toolName)) owned(ctx)?.toolStart(event);
  });
  api.on("after_tool_call", (event, ctx) => { owned(ctx)?.toolEnd(event); });
  api.on("agent_end", (event, ctx) => { owned(ctx)?.runEnded(!event.success); });
}
