import { createHash } from 'node:crypto';
import { sendMessage } from './api-fetch.js';
import { ChannelType } from './types.js';
import type { DocCommentMention } from './doc-mention.js';

/** No document title, content, URL or model output leaves the comment channel. */
export async function sendDocPermissionNotice(apiUrl: string, botToken: string, mention: DocCommentMention, signal: AbortSignal): Promise<void> {
  if (!mention.fromUid.trim() || mention.fromUid === mention.botUid) throw new Error('Invalid document task requester');
  const result = await sendMessage({ apiUrl, botToken, channelId: mention.fromUid, channelType: ChannelType.DM,
    content: '你发起的一条文档 @Bot 任务无法回传答复：评论接口拒绝了当前权限。请先检查文档中的实际修改结果，并联系管理员确认权限；本提示不会重新执行任务。',
    clientMsgNo: createHash('sha256').update(JSON.stringify(['doc-permission-notice', mention.botUid, mention.fromUid, mention.idempotencyKey])).digest('hex').slice(0, 32),
    signal,
  });
  // A successful HTTP status alone does not confirm IM delivery (see issue #51).
  const messageId = result?.message_id ? String(result.message_id).trim() : '';
  if (!messageId) throw new Error('Octo send API returned no message_id for the permission notice');
}
