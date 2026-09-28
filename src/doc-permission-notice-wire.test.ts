import { beforeEach, expect, it, vi } from 'vitest';
import { sendDocPermissionNotice } from './doc-permission-notice.js';
import { sendMessage } from './api-fetch.js';
import { createDocMentionHandler } from './doc-mention-handler.js';
import { createMemoryDocMentionDedupeStore } from './doc-mention-dedupe.js';
import type { DocCommentMention } from './doc-mention.js';
import { OctoApiError } from './api-error.js';
vi.mock('./api-fetch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api-fetch.js')>(),
  sendMessage: vi.fn(async () => ({ message_id: '1' })),
}));
beforeEach(() => {
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockResolvedValue({ message_id: '1' } as never);
});
const receiptMention: DocCommentMention = { eventId: 1, idempotencyKey: 'receipt-key', docId: 'secret-doc', commentId: '17', threadId: '13', fromUid: 'human', botUid: 'bot', text: 'secret-body', docKind: 'ppt' };

it.each([undefined, {}, { status: 0 }, { message_id: '' }, { message_id: '  ' }, { message_id: 0 }])('retains the dead letter for an unconfirmed IM receipt: %j', async receipt => {
  vi.mocked(sendMessage).mockResolvedValue(receipt as never);
  const record = vi.fn(async () => {}), info = vi.fn();
  const dispatch = vi.fn(async (_message: unknown, _route: unknown, extra: any) => {
    await extra.docTask.onAgentTurnStarted();
    await extra.docTask.postComment('private answer', undefined, 'final');
    return 'completed' as const;
  });
  const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(), dispatch,
    postComment: async () => { throw new OctoApiError({status:403,path:'/comments',body:'denied',retryAfterMs:0}); },
    notifyPermissionFailure: (mention, signal) => sendDocPermissionNotice('https://gateway.invalid', 'test-token', mention, signal),
    deadLetter: { record, list: async () => [] }, log: { info },
  });
  await handler(receiptMention); await handler(receiptMention);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'undelivered_after_ack', idempotencyKey: receiptMention.idempotencyKey }));
  expect(info.mock.calls.flat().join('\n')).not.toContain('requester permission notice delivered');
});

it.each(['', ' ', 'bot'])('rejects an invalid requester %j before IM egress', async fromUid => {
  await expect(sendDocPermissionNotice('https://gateway.invalid', 'test-token', { ...receiptMention, fromUid }, new AbortController().signal)).rejects.toThrow('Invalid document task requester');
  expect(sendMessage).not.toHaveBeenCalled();
});

it('partitions receipt keys by task, requester and bot', async () => {
  for (const mention of [receiptMention, { ...receiptMention, idempotencyKey: 'other-task' }, { ...receiptMention, fromUid: 'other-human' }, { ...receiptMention, botUid: 'other-bot' }]) {
    await sendDocPermissionNotice('https://gateway.invalid', 'test-token', mention, new AbortController().signal);
  }
  expect(new Set(vi.mocked(sendMessage).mock.calls.map(([request]) => request.clientMsgNo)).size).toBe(4);
});

it('logs confirmed delivery and suppresses only the undelivered notice dead letter', async () => {
  const record = vi.fn(async () => {}), info = vi.fn();
  const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(),
    dispatch: async () => 'dropped', postComment: async () => { throw new OctoApiError({status:403,path:'/comments',body:'denied',retryAfterMs:0}); },
    notifyPermissionFailure: (mention, signal) => sendDocPermissionNotice('https://gateway.invalid', 'test-token', mention, signal),
    deadLetter: { record, list: async () => [] }, log: { info },
  });
  await handler(receiptMention);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith('octo: requester permission notice delivered doc=secret-doc thread=13');
});
it('uses a stable requester-only DM with fixed text and no task data or external URL', async () => {
  const mention = { eventId: 1, idempotencyKey: 'key', docId: 'secret-doc', commentId: '1', threadId: '1', fromUid: 'human', botUid: 'bot', text: 'secret-body', url: 'https://attacker.invalid' };
  await sendDocPermissionNotice('https://gateway.invalid', 'test-token', mention, new AbortController().signal);
  await sendDocPermissionNotice('https://gateway.invalid', 'test-token', mention, new AbortController().signal);
  const first = vi.mocked(sendMessage).mock.calls[0][0], second = vi.mocked(sendMessage).mock.calls[1][0];
  expect(first).toMatchObject({ apiUrl: 'https://gateway.invalid', channelId: 'human', channelType: 1 });
  expect(first.clientMsgNo).toBe(second.clientMsgNo);
  expect(first.content).toBe('你发起的一条文档 @Bot 任务无法回传答复：评论接口拒绝了当前权限。请先检查文档中的实际修改结果，并联系管理员确认权限；本提示不会重新执行任务。');
  expect(second.content).toBe(first.content);
  expect(first.content).not.toMatch(/secret-doc|secret-body|attacker|test-token/);
});
