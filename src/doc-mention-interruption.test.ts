import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocMentionHandler, type DocMentionDispatch } from './doc-mention-handler.js';
import { createMemoryDocMentionDedupeStore } from './doc-mention-dedupe.js';
import { parseDocCommentMention } from './doc-mention.js';
import type { DocTaskProgress } from './doc-task-progress.js';

const mention = () => parseDocCommentMention({ event_id: 1, event_type: 'doc_comment_mention', event_data: {
  idempotency_key: 'ppt-probe-stop', doc_id: 'deck', doc_kind: 'ppt', comment_id: '2', thread_id: '1',
  from_uid: 'human', bot_uid: 'bot', text: 'update the deck',
} })!;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => vi.useRealTimers());

describe('handler-owned PPT interruptions', () => {
  for (const phase of ['initial', 'continuation'] as const) {
    for (const cause of ['cancel', 'deadline'] as const) {
      it.each(['resolve', 'reject'] as const)(`${phase} revision ${cause} with %s preserves the execution outcome`, async settlement => {
        const controller = new AbortController();
        const sent: DocTaskProgress[] = [];
        const postComment = vi.fn(async () => {});
        let entered!: () => void, resolve!: (revision: number) => void, reject!: (error: Error) => void;
        const reading = new Promise<void>(r => { entered = r; });
        const probe = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
        const readPptRevision = vi.fn(async (): Promise<number> => {
          if (phase === 'continuation' && readPptRevision.mock.calls.length === 1) return 1;
          entered(); return probe;
        });
        const dispatch = vi.fn<DocMentionDispatch>(async (_message, _route, { docTask }) => {
          await docTask.onAgentTurnStarted?.();
          await docTask.postComment('我会先读取再修改。', undefined, 'final');
          docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
          return 'completed';
        });
        const handler = createDocMentionHandler({ botUid: 'bot', signal: controller.signal, dispatchTimeoutMs: 100,
          dedupe: createMemoryDocMentionDedupeStore(), readPptRevision, dispatch, postComment,
          reportProgress: async (_mention, value) => { sent.push(value); },
        });
        const task = handler(mention());
        await reading;
        expect(dispatch).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
        if (cause === 'cancel') controller.abort();
        else vi.setSystemTime(1100);
        if (settlement === 'resolve') resolve(1);
        else reject(new DOMException('probe stopped', 'AbortError'));
        await task;
        expect(dispatch).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
        expect(sent.at(-1)).toMatchObject({ state: phase === 'initial' ? 'unknown' : 'finished', phase: 'ended',
          replyDelivered: phase === 'continuation', steps: [],
        });
        expect(sent.at(-1)?.errorCode).toBe(phase === 'initial' ? 'interrupted' : undefined);
        if (phase === 'continuation') {
          await handler(mention());
          expect(dispatch).toHaveBeenCalledOnce(); // Never replay a possibly editing first turn.
          expect(readPptRevision).toHaveBeenCalledTimes(2);
        }
      });
    }
  }
  it('keeps a delivered answer finished when the continuation probe uses the remaining sub-10s budget', async () => {
    vi.useRealTimers();
    const sent: DocTaskProgress[] = [];
    const controller = new AbortController();
    let reads = 0, probeSignal: AbortSignal | undefined;
    const dispatch = vi.fn<DocMentionDispatch>(async (_message, _route, { docTask }) => {
      await docTask.postComment('我会先读取再修改。', undefined, 'final');
      docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      return 'completed';
    });
    await createDocMentionHandler({ botUid: 'bot', signal: controller.signal, dispatchTimeoutMs: 150,
      dedupe: createMemoryDocMentionDedupeStore(), dispatch, postComment: async () => {},
      readPptRevision: async (_mention, signal) => {
        if (++reads === 1) return 1;
        probeSignal = signal;
        return new Promise<number>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
      },
      reportProgress: async (_mention, value) => { sent.push(value); },
    })(mention());
    expect(reads).toBe(2);
    expect(probeSignal?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ state: 'finished', replyDelivered: true });
    expect(sent.at(-1)?.errorCode).toBeUndefined();
  });
  it.each(['cancel', 'deadline', 'none'] as const)('preserves delivered work when the changed-revision probe observes %s', async cause => {
    const sent: DocTaskProgress[] = [], controller = new AbortController();
    let reads = 0;
    const dispatch = vi.fn<DocMentionDispatch>(async (_message, _route, { docTask }) => {
      await docTask.postComment('我会先读取再修改。', undefined, 'final');
      docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      return 'completed';
    });
    await createDocMentionHandler({ botUid: 'bot', signal: controller.signal, dispatchTimeoutMs: 100,
      dedupe: createMemoryDocMentionDedupeStore(), dispatch, postComment: async () => {},
      readPptRevision: async () => {
        if (++reads === 1) return 1;
        if (cause === 'cancel') controller.abort();
        if (cause === 'deadline') vi.setSystemTime(1100);
        return 2;
      },
      reportProgress: async (_mention, value) => { sent.push(value); },
    })(mention());
    expect(reads).toBe(2); expect(dispatch).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ state: 'finished', replyDelivered: true });
    expect(sent.at(-1)?.errorCode).toBeUndefined();
  });
  it('reports a pre-aborted task without reading or dispatching', async () => {
    const sent: DocTaskProgress[] = [];
    const readPptRevision = vi.fn(async () => 1);
    const dispatch = vi.fn<DocMentionDispatch>(async () => 'completed');
    await createDocMentionHandler({ botUid: 'bot', signal: AbortSignal.abort(),
      dedupe: createMemoryDocMentionDedupeStore(), readPptRevision, dispatch, postComment: async () => {},
      reportProgress: async (_mention, value) => { sent.push(value); },
    })(mention());
    expect(readPptRevision).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ state: 'unknown', errorCode: 'interrupted', replyDelivered: false });
  });
  it.each(['network', 'probe-timeout'])('keeps a successful turn finished after an independent %s failure', async cause => {
    const sent: DocTaskProgress[] = [];
    const dispatch = vi.fn<DocMentionDispatch>(async (_message, _route, { docTask }) => {
      await docTask.postComment('已完成修改并读回。', undefined, 'final');
      docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      return 'completed';
    });
    await createDocMentionHandler({ botUid: 'bot', dispatchTimeoutMs: 20_000,
      dedupe: createMemoryDocMentionDedupeStore(), dispatch, postComment: async () => {},
      readPptRevision: async () => {
        vi.setSystemTime(11_000); // The probe's 10s deadline is shorter than the task's budget.
        throw cause === 'network' ? new Error('revision unavailable') : new DOMException('probe timed out', 'TimeoutError');
      },
      reportProgress: async (_mention, value) => { sent.push(value); },
    })(mention());
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ state: 'finished', replyDelivered: true });
    expect(sent.at(-1)?.errorCode).toBeUndefined();
  });
});
