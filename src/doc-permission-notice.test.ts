import { expect, it, vi } from 'vitest';
import { createDocMentionHandler } from './doc-mention-handler.js';
import { createMemoryDocMentionDedupeStore } from './doc-mention-dedupe.js';
import type { DocCommentMention } from './doc-mention.js';
import { OctoApiError } from './api-error.js';
import { postDocComment } from './api-fetch.js';

it.each([
 JSON.stringify({status:0,msg:'upstream write failed (403) at edge'}),
 JSON.stringify({status:0,msg:'permission denied'}),
 'invalid JSON: upstream failed (403)',
])('does not arm a permission DM from HTTP 200 body text: %s',async body=>{
 const record=vi.fn(async()=>{}),notifyPermissionFailure=vi.fn(async()=>{});
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(body,{status:200}));
 try {
  const handler=createDocMentionHandler({botUid:'bot',dedupe:createMemoryDocMentionDedupeStore(),dispatch:async()=> 'dropped',
   postComment:()=>postDocComment({apiUrl:'https://gateway.invalid',botToken:'test-only',docId:'d_1',body:'failure',parentId:1}),
   notifyPermissionFailure,deadLetter:{record,list:async()=>[]}});
  await handler(mention);
  expect(notifyPermissionFailure).not.toHaveBeenCalled();
  expect(record).toHaveBeenCalledTimes(1);
 } finally {fetcher.mockRestore();}
});

it('logs bounded failure categories and task identifiers without upstream secrets',async()=>{
 const error=vi.fn(),record=vi.fn(async()=>{});
 const handler=createDocMentionHandler({botUid:'bot',dedupe:createMemoryDocMentionDedupeStore(),dispatch:async()=> 'dropped',
  postComment:async()=>{throw new OctoApiError({status:403,path:'/comments',body:'denied',retryAfterMs:0});},
  notifyPermissionFailure:async()=>{throw new OctoApiError({status:503,path:'/sendMessage',body:'SECRET_TOKEN',retryAfterMs:0});},
  deadLetter:{record,list:async()=>[]},log:{error}});
 await handler(mention);
 expect(error).toHaveBeenCalledWith('octo: requester permission notice failed doc="d_1" thread="1" cause=http_503; retaining dead letter');
 expect(error.mock.calls.flat().join('\n')).not.toContain('SECRET_TOKEN');
 expect(record).toHaveBeenCalledTimes(1);
});

const mention: DocCommentMention = { eventId: 1, idempotencyKey: 'permission-test', docId: 'd_1', commentId: '1', threadId: '1', fromUid: 'requester', botUid: 'bot', text: 'private task', docKind: 'ppt' };
it('notifies only the requester after a forbidden reply, without replaying the agent', async () => {
  const notifyPermissionFailure = vi.fn(async (_mention: DocCommentMention, _signal: AbortSignal) => {}), postComment = vi.fn(async () => { throw new OctoApiError({status:403,path:'/comments',body:'denied',retryAfterMs:0}); });
  const dispatch = vi.fn(async (_message: unknown, _route: unknown, extra: any) => {
    await extra.docTask.onAgentTurnStarted();
    await extra.docTask.postComment('private answer', undefined, 'final');
    return 'completed' as const;
  });
  const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(), dispatch, postComment, notifyPermissionFailure });
  await handler(mention); await handler(mention);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(notifyPermissionFailure).toHaveBeenCalledTimes(1);
  expect(notifyPermissionFailure.mock.calls[0]?.[0]).toBe(mention);
});
it.each([404, 500])('does not claim permission loss for HTTP %s', async status => {
  const notifyPermissionFailure = vi.fn(async () => {});
  const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(), dispatch: async () => 'dropped', postComment: async () => { throw new Error(`Octo API failed (${status})`); }, notifyPermissionFailure });
  await handler(mention); expect(notifyPermissionFailure).not.toHaveBeenCalled();
});
it('retains a dead letter when the requester notification also fails', async () => {
  const record = vi.fn(async () => {});
  const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(), dispatch: async () => 'dropped', postComment: async () => { throw new OctoApiError({status:403,path:'/comments',body:'denied',retryAfterMs:0}); }, notifyPermissionFailure: async () => { throw new Error('unavailable'); }, deadLetter: { record, list: async () => [] } });
  await expect(handler(mention)).resolves.toBeUndefined(); expect(record).toHaveBeenCalledTimes(1);
});

it('does not send a DM when the fallback comment succeeds', async () => {
  const notifyPermissionFailure = vi.fn(async () => {});
  const handler = createDocMentionHandler({ botUid: 'bot', dedupe: createMemoryDocMentionDedupeStore(), dispatch: async () => 'dropped', postComment: async () => {}, notifyPermissionFailure });
  await handler(mention);
  expect(notifyPermissionFailure).not.toHaveBeenCalled();
});

it('does not start a DM after the account stops during a forbidden comment', async () => {
  const controller = new AbortController(), notifyPermissionFailure = vi.fn(async () => {});
  const handler = createDocMentionHandler({ botUid: 'bot', signal: controller.signal, dedupe: createMemoryDocMentionDedupeStore(), dispatch: async () => 'dropped', postComment: async () => { controller.abort(); throw new OctoApiError({status:403,path:'/comments',body:'denied',retryAfterMs:0}); }, notifyPermissionFailure });
  await handler(mention);
  expect(notifyPermissionFailure).not.toHaveBeenCalled();
});

it.each(['unavailable', 'delivered', 'dm-failed', 'stopped'] as const)('remembers final-answer 403 when the fallback is %s', async mode => {
  const controller = new AbortController();
  const notifyPermissionFailure = vi.fn(async () => { if (mode === 'dm-failed') throw new Error('DM unavailable'); });
  const record = vi.fn(async () => {});
  const postComment = vi.fn(async (_mention: DocCommentMention, _text: string, _signal?: AbortSignal, intent?: string) => {
    if (intent === 'final') throw new OctoApiError({status:403,path:'/comments',body:'denied',retryAfterMs:0});
    if (mode === 'delivered') return;
    if (mode === 'stopped') controller.abort();
    throw new Error('Octo API failed (500)');
  });
  const dispatch = vi.fn(async (_message: unknown, _route: unknown, extra: any) => {
    await extra.docTask.onAgentTurnStarted();
    await extra.docTask.postComment('private answer', undefined, 'final');
    return 'completed' as const;
  });
  const handler = createDocMentionHandler({ botUid: 'bot', signal: controller.signal,
    dedupe: createMemoryDocMentionDedupeStore(), dispatch, postComment, notifyPermissionFailure,
    deadLetter: { record, list: async () => [] } });
  await handler(mention); await handler(mention);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(notifyPermissionFailure).toHaveBeenCalledTimes(mode === 'delivered' || mode === 'stopped' ? 0 : 1);
  expect(record).toHaveBeenCalledTimes(mode === 'dm-failed' || mode === 'stopped' ? 1 : 0);
  expect(postComment).toHaveBeenCalledTimes(mode === 'delivered' || mode === 'stopped' ? 2 : 4);
});
