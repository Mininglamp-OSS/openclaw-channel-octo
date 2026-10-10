import { postDocTaskProgress } from './api-fetch.js';
import * as toolPolicy from './doc-task-tool-policy.js';
import * as apiError from './api-error.js';
import * as eventContent from './doc-task-events.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocTaskTracker, registerDocTaskProgress, type DocTaskProgress } from './doc-task-progress.js';
import { createDocMentionHandler } from './doc-mention-handler.js';
import { createMemoryDocMentionDedupeStore } from './doc-mention-dedupe.js';
import { parseDocCommentMention } from './doc-mention.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const hooks = new Map<string, (event: any, ctx: any) => unknown>();
const ctx = { sessionKey: 'test-doc', runId: 'run-1' };
const fire = (hook: string, event = {}, context = ctx) => hooks.get(hook)!(event, context);
beforeEach(() => {
  vi.useFakeTimers();
  registerDocTaskProgress({ on: (name: string, fn: any) => hooks.set(name, fn) } as never);
});
afterEach(() => vi.useRealTimers());

describe('document execution receipts', () => {
  it('logs safe receipt failure categories and document kinds without upstream content', async () => {
    const log = { error: vi.fn() };
    const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(), log,
      reportProgress: async () => { throw new apiError.OctoApiError({ status: 404, path: '/private-path', body: 'SECRET_CONTENT', retryAfterMs: 0 }); },
      postComment: async () => {}, dispatch: async () => 'dropped',
    });
    const mention = parseDocCommentMention({ event_id: 1, event_type: 'doc_comment_mention', event_data: {
      idempotency_key: 'safe-receipt-log', doc_id: 'private-slug', doc_kind: 'html', comment_id: '2', thread_id: '1', from_uid: 'human', bot_uid: 'bot', text: 'read',
    } })!;
    await handler(mention);
    expect(log.error).toHaveBeenCalledOnce();
    const message = log.error.mock.calls.flat().join(' ');
    expect(message).toContain('kind=html'); expect(message).toContain('cause=http_404');
    expect(message).not.toMatch(/SECRET_CONTENT|private-path|private-slug/);
  });

  it('shares task ownership between isolated channel and agent VM globals', async () => {
    const code = ts.transpileModule(readFileSync(new URL('./doc-task-progress.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const load = () => {
      const exports: Record<string, any> = {};
      runInNewContext(code, { exports, require: (id: string) => id === './doc-task-events.js' ? eventContent : id === './api-error.js' ? apiError : id === './doc-task-tool-policy.js' ? toolPolicy : createRequire(import.meta.url)(id), process,
        AbortController, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval });
      return exports;
    };
    const channel = load(), agent = load(), sent: DocTaskProgress[] = [], events: eventContent.DocTaskEvent[] = [];
    const isolatedHooks = new Map<string, (event: any, context: any) => void>();
    agent.registerDocTaskProgress({ on: (name: string, fn: any) => isolatedHooks.set(name, fn) });
    const tracker = new channel.DocTaskTracker(async (s: DocTaskProgress, batch: eventContent.DocTaskEvent[] = []) => { sent.push(s); events.push(...batch); });
    const context = { sessionKey: 'separate-vm-task', runId: 'owned-vm-run' };
    const detach = tracker.attach(context.sessionKey);
    try {
      isolatedHooks.get('before_agent_run')!({}, context);
      isolatedHooks.get('model_call_started')!({}, context);
      isolatedHooks.get('before_tool_call')!(runInNewContext('({ toolName: "exec", toolCallId: "date-call", params: { command: "date", count: 0 } })'), context);
      isolatedHooks.get('after_tool_call')!(runInNewContext('({ toolCallId: "date-call", result: { details: { exitCode: 0 }, content: [{ type: "text", text: "Thursday" }] } })'), context);
      await vi.advanceTimersByTimeAsync(300);
      expect(sent.at(-1)).toMatchObject({ state: 'running', steps: [{ tool: 'exec', state: 'finished', exitCode: 0 }] });
      expect(events).toHaveLength(2);
      expect(JSON.parse(events[0].content)).toEqual({ command: 'date', count: 0 });
      expect(events[1]).toMatchObject({ type: 'tool_result', content: 'Thursday', truncated: false });
      isolatedHooks.get('agent_end')!({ success: false }, context);
      await tracker.finish({ finalDelivered: false });
      expect(sent.at(-1)).toMatchObject({ state: 'failed', errorCode: 'dispatch_failed' });
    } finally { detach(); await tracker.finish({ finalDelivered: false }); }
  });
  it('starts waiting and requires an owned actual model/tool event before running', async () => {
    const sent: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async s => { sent.push(s); });
    const detach = tracker.attach(ctx.sessionKey);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.at(-1)?.state).toBe('waiting');
    fire('model_call_started');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.at(-1)?.state).toBe('waiting');
    fire('before_agent_run');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.at(-1)?.state).toBe('waiting');
    fire('model_call_started', {}, { ...ctx, runId: 'late-other-run' });
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.at(-1)?.state).toBe('waiting');
    fire('model_call_started');
    await vi.advanceTimersByTimeAsync(300);
    expect(sent.at(-1)?.state).toBe('running');
    detach(); await tracker.finish({ finalDelivered: true });
  });
  it('keeps the received snapshot live while queued before runtime attachment', async () => {
    const sent: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async s => { sent.push(s); });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    expect(sent.every(s => s.state === 'waiting')).toBe(true);
    expect(sent.at(-1)!.sequence).toBeGreaterThan(sent[0].sequence);
    await tracker.finish({ finalDelivered: false });
  });
  it('pairs concurrent same-name tools by call ID and publishes no raw params/results/errors', async () => {
    const sent: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async s => { sent.push(s); });
    const detach = tracker.attach(ctx.sessionKey); fire('before_agent_run');
    fire('before_tool_call', { toolName: 'exec', toolCallId: 'a', params: { command: 'secret-command' } });
    fire('before_tool_call', { toolName: 'exec', toolCallId: 'b' });
    fire('after_tool_call', { toolCallId: 'b', result: { details: { exitCode: 1 }, text: 'secret-output' } });
    fire('after_tool_call', { toolCallId: 'missing', error: 'secret-error' });
    fire('after_tool_call', { toolCallId: 'a', result: { isError: false }, durationMs: 100 });
    await tracker.finish({ finalDelivered: true }); detach();
    expect(sent.at(-1)?.steps.map(s => [s.id, s.state])).toEqual([['call-1', 'finished'], ['call-2', 'failed']]);
    expect(sent.at(-1)?.state).toBe('finished'); // tool failure followed by recovery is not a runtime failure
    expect(JSON.stringify(sent)).not.toMatch(/secret-|params|command|result/);
  });
  it('keeps old hooks and old detach callbacks out of a replacement task', async () => {
    const old = new DocTaskTracker(async () => {}), sent: DocTaskProgress[] = [];
    const detachOld = old.attach(ctx.sessionKey); fire('before_agent_run');
    const next = new DocTaskTracker(async s => { sent.push(s); });
    const detachNext = next.attach(ctx.sessionKey);
    const nextCtx = { ...ctx, runId: 'run-2' };
    fire('before_agent_run', {}, nextCtx); detachOld();
    fire('before_tool_call', { toolName: 'exec', toolCallId: 'old' });
    fire('before_tool_call', { toolName: 'read', toolCallId: 'new' }, nextCtx);
    await next.finish({ finalDelivered: true }); detachNext(); await old.finish({ finalDelivered: false });
    expect(sent.at(-1)?.steps.map(s => s.tool)).toEqual(['read']);
  });
  it('reports interrupted execution as unknown even if a reply was already delivered', async () => {
    const sent: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async s => { sent.push(s); });
    tracker.toolStart({ toolCallId: 'a', toolName: 'exec' });
    tracker.runEnded(true, true);
    await tracker.finish({ finalDelivered: true });
    expect(sent.at(-1)).toMatchObject({ state: 'unknown', phase: 'ended', replyDelivered: true, errorCode: 'interrupted', steps: [{ state: 'unknown' }] });
    tracker.toolEnd({ toolCallId: 'a' });
    expect(sent.at(-1)?.steps[0].state).toBe('unknown');
  });
  it('coalesces a slow transport and flushes its final snapshot; failures and logger errors never escape', async () => {
    let release!: () => void;
    const sent: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async s => {
      sent.push(s);
      if (sent.length === 1) await new Promise<void>(r => { release = r; });
      else throw new Error('unavailable');
    }, () => { throw new Error('logger unavailable'); });
    await vi.advanceTimersByTimeAsync(1);
    tracker.activity('model'); await vi.advanceTimersByTimeAsync(300);
    const finished = tracker.finish({ finalDelivered: true });
    release(); await vi.advanceTimersByTimeAsync(3000); await expect(finished).resolves.toBeUndefined();
    expect(sent).toHaveLength(4);
    expect(sent.slice(1).every(s => s.sequence === sent[1].sequence)).toBe(true);
    expect(sent[1]).toMatchObject({ state: 'finished', phase: 'ended' });
    expect(sent[1].sequence).toBeGreaterThan(sent[0].sequence);
  });
  it.each([false, true])('bounds terminal drain and cancels transport (hung=%s)', async hung => {
    const sent: DocTaskProgress[] = [], signals: AbortSignal[] = [];
    const tracker = new DocTaskTracker(async (p, _events, signal) => {
      sent.push(p); signals.push(signal!);
      if (hung) await new Promise<void>(() => {}); // Even a non-cooperative transport cannot hold finish.
      else await new Promise<void>(resolve => setTimeout(resolve, 2000));
    });
    for (let i = 0; i < 1000; i++) tracker.toolStart({ toolName: 'read', toolCallId: String(i) });
    await vi.advanceTimersByTimeAsync(250);
    let ended = false;
    const finished = tracker.finish({ finalDelivered: true }).then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ended).toBe(true);
    await finished;
    expect(signals.every(s => s.aborted)).toBe(true);
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(count);
    if (!hung) expect(sent[1]).toMatchObject({ phase: 'ended', eventCount: 1000 });
  });
  it.each([403, 404, 409])('does not retry permanent HTTP %i failures across snapshots', async status => {
    const send = vi.fn(async () => { throw new apiError.OctoApiError({ path: '/comment-task', status, body: '', retryAfterMs: 1000 }); });
    const tracker = new DocTaskTracker(send);
    await vi.advanceTimersByTimeAsync(0);
    tracker.activity('model');
    await vi.advanceTimersByTimeAsync(30_000);
    const finish = tracker.finish({ finalDelivered: true });
    await vi.advanceTimersByTimeAsync(5000);
    await finish;
    expect(send).toHaveBeenCalledOnce();
  });
  it('does not record vetoed document tools even when the observer runs first', async () => {
    const sent: DocTaskProgress[] = [], events: eventContent.DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (s, batch = []) => { sent.push(s); events.push(...batch); });
    const context = { sessionKey: 'agent:one:octo:acct:doctask:doc:thread', runId: 'blocked-tools' };
    const detach = tracker.attach(context.sessionKey);
    try {
      fire('before_agent_run', {}, context);
      for (const toolName of ['sessions_spawn', 'sessions_yield']) {
        // Invoke the observer directly before the veto; host ordering cannot mask this pin.
        fire('before_tool_call', { toolName, toolCallId: toolName, params: {} }, context);
        fire('after_tool_call', { toolCallId: toolName, result: 'blocked' }, context);
      }
      await tracker.finish({ finalDelivered: true });
      expect(sent.at(-1)?.steps).toEqual([]);
      expect(events).toEqual([]);
    } finally { detach(); }
  });
  it.each([2000, 60_000])('honors Retry-After=%i across newer snapshots and terminal cutoff', async retryAfterMs => {
    const sent: { at: number; snapshot: DocTaskProgress; batch: eventContent.DocTaskEvent[] }[] = [];
    const start = Date.now();
    const tracker = new DocTaskTracker(async (snapshot, batch = []) => {
      sent.push({ at: Date.now() - start, snapshot, batch });
      if (sent.length === 1) throw new apiError.OctoApiError({ path: '/comment-task', status: 429, body: '', retryAfterMs });
    });
    await vi.advanceTimersByTimeAsync(0);
    tracker.toolStart({ toolName: 'read', toolCallId: 'rate-limited', params: { path: 'safe' } });
    await vi.advanceTimersByTimeAsync(300);
    const finish = tracker.finish({ finalDelivered: true });
    await vi.advanceTimersByTimeAsync(1699);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3301);
    await finish;
    if (retryAfterMs === 2000) {
      expect(sent[1].at).toBeGreaterThanOrEqual(2000);
      expect(sent.at(-1)?.snapshot.phase).toBe('ended');
      expect(sent.at(-1)?.batch[0].seq).toBe(1);
    } else expect(sent).toHaveLength(1);
    const count = sent.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(count);
  });
  it('bounds retained tools and preserves the omitted count', async () => {
    const sent: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async s => { sent.push(s); });
    for (let i = 0; i < 104; i++) tracker.toolStart({ toolName: 'exec', toolCallId: String(i) });
    await tracker.finish({ finalDelivered: true });
    expect(sent.at(-1)?.steps).toHaveLength(100);
    expect(sent.at(-1)?.omittedSteps).toBe(4);
  });
  it('limits progress failure logs across retries and tasks without losing final replies', async () => {
    const log = { error: vi.fn() };
    const reportProgress = vi.fn(async () => { throw new Error('unavailable'); });
    const postComment = vi.fn(async () => {});
    const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(), reportProgress, log, postComment,
      dispatch: async (_, __, extra) => {
        await extra.docTask.postComment('done', undefined, 'final');
        extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
        return 'completed';
      },
    });
    const run = async (id: number) => {
      const mention = parseDocCommentMention({ event_id: id, event_type: 'doc_comment_mention', event_data: {
        idempotency_key: 'log-' + id, doc_id: 'doc', comment_id: String(id), thread_id: '1', from_uid: 'human', bot_uid: 'bot', text: 'read',
      } })!;
      const task = handler(mention);
      await vi.advanceTimersByTimeAsync(5000); await task;
    };
    await run(1); await run(2);
    expect(reportProgress.mock.calls.length).toBeGreaterThan(2);
    expect(log.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); await run(3);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(postComment).toHaveBeenCalledTimes(3);
  });
  it('posts the failure notice without waiting for a hung receipt drain', async () => {
    const postComment = vi.fn(async () => {});
    const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(), postComment,
      reportProgress: async () => new Promise<void>(() => {}), dispatch: async () => 'dropped',
    });
    const mention = parseDocCommentMention({ event_id: 1, event_type: 'doc_comment_mention', event_data: {
      idempotency_key: 'fast-notice', doc_id: 'doc', comment_id: '2', thread_id: '1', from_uid: 'human', bot_uid: 'bot', text: 'read',
    } })!;
    const task = handler(mention);
    await vi.advanceTimersByTimeAsync(0);
    expect(postComment).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000); await task;
  });
  it.each(['{}', '{"accepted":false}', '<html>proxy</html>'])('stops receipt retries on a successful HTTP response with invalid receipt %s', async body => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status: 200 }));
    const tracker = new DocTaskTracker((progress, events, signal) => postDocTaskProgress({
      apiUrl: 'http://receipt.test', botToken: 'fixture', docId: 'doc', idempotencyKey: 'key', progress, events, signal,
    }));
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      const finish = tracker.finish({ finalDelivered: true });
      await vi.advanceTimersByTimeAsync(5000); await finish;
      expect(fetch).toHaveBeenCalledOnce();
    } finally { fetch.mockRestore(); }
  });
  it('wires actual comment handler lifecycle to receipts without requiring an IM card', async () => {
    const sent: DocTaskProgress[] = [];
    const mention = parseDocCommentMention({ event_id: 1, event_type: 'doc_comment_mention', event_data: {
      idempotency_key: 'key', doc_id: 'doc', comment_id: '2', thread_id: '1', from_uid: 'human', bot_uid: 'bot', text: 'read',
    } })!;
    const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(),
      reportProgress: async (_, p) => { sent.push(p); }, postComment: async () => {},
      dispatch: async (_, __, extra) => {
        const detach = extra.docTask.progress!.attach(ctx.sessionKey); fire('before_agent_run');
        fire('before_tool_call', { toolName: 'read', toolCallId: 'a' });
        fire('after_tool_call', { toolCallId: 'a' });
        await extra.docTask.postComment('read complete', undefined, 'final');
        extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
        detach(); return 'completed';
      },
    });
    await handler(mention);
    expect(sent.at(-1)).toMatchObject({ state: 'finished', replyDelivered: true, steps: [{ tool: 'read', state: 'finished' }] });
  });
});
