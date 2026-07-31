import { docCommentParentId, docTaskQueueScope, docTaskSessionScope, synthesizeDocMentionMessage, type DocCommentMention } from "./doc-mention.js";
import type { DocMentionDedupeStore } from "./doc-mention-dedupe.js";
import type { BotMessage } from "./types.js";

/** channel.ts 侧 dispatchInboundMessage 的最小契约。 */
export type DocMentionDispatch = (
  message: BotMessage,
  routeOverride: undefined,
  extra: {
    queueScope: string;
    docTask: {
      docId: string;
      threadId: string;
      sessionScope: string;
      postComment: (text: string, signal?: AbortSignal) => Promise<void>;
    };
  },
) => Promise<"completed" | "dropped">;

export interface DocMentionHandlerDeps {
  botUid: string;
  dedupe: DocMentionDedupeStore;
  dispatch: DocMentionDispatch;
  postComment: (mention: DocCommentMention, text: string, signal?: AbortSignal) => Promise<void>;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}

/**
 * 文档任务的接线逻辑。抽成独立函数是为了能被直接测试 —— 放在 startAccount 的闭包里
 * 时,测试只能重新实现一遍接线,于是接线本身的回归(去重时机、异常是否外抛)抓不到。
 *
 * 三条不变量:
 *   1. 只有跑完的任务才写持久去重(complete),被拒/异常一律 release,允许重投重放;
 *   2. 异常不外抛 —— 外抛会让轮询器的游标停在原地,重投后再次失败,形成每个轮询
 *      周期一次的死循环。用户可见的道歉此时已由 inbound 的出站收口发进评论区,
 *      任务算「已处理(失败)」,让游标推进并 ack 才是收敛的做法;
 *   3. 事件指向别的 bot 时在 claim 之前丢弃,避免用外部 bot 的 key 污染去重存储。
 */
export function createDocMentionHandler(deps: DocMentionHandlerDeps) {
  return async function handleDocMention(mention: DocCommentMention): Promise<void> {
    if (mention.botUid !== deps.botUid) {
      deps.log?.error?.(`octo: doc mention bot_uid=${mention.botUid} != this bot ${deps.botUid}, dropped`);
      return;
    }
    if (await deps.dedupe.claim(mention.idempotencyKey)) {
      deps.log?.info?.(`octo: doc mention ${mention.idempotencyKey} already processed, skipped`);
      return;
    }

    let outcome: "completed" | "dropped" = "dropped";
    try {
      outcome = await deps.dispatch(synthesizeDocMentionMessage(mention, deps.botUid), undefined, {
        queueScope: docTaskQueueScope(mention),
        docTask: {
          docId: mention.docId,
          threadId: mention.threadId,
          sessionScope: docTaskSessionScope(mention),
          postComment: (text, signal) => deps.postComment(mention, text, signal),
        },
      });
    } catch (err) {
      deps.log?.error?.(
        `octo: doc task dispatch failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
      );
    } finally {
      if (outcome === "completed") await deps.dedupe.complete(mention.idempotencyKey);
      else deps.dedupe.release(mention.idempotencyKey);
    }
  };
}

export { docCommentParentId };
