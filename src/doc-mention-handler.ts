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

/** 兜底评论:本轮一条评论都没发出去时补发,保证评论区不会毫无痕迹。 */
const NOTHING_DELIVERED_NOTICE = "⚠️ 本次文档任务没有完成，也没有产生任何修改。请稍后重试或重新 @ 我。";

/** 回帖的有界重试:docs 后端一次瞬时 5xx 不该让整条回复永久消失。 */
const POST_ATTEMPTS = 3;
const POST_RETRY_BASE_MS = 200;

/**
 * 文档任务的接线逻辑。抽成独立函数是为了能被直接测试 —— 放在 startAccount 的闭包里
 * 时,测试只能重新实现一遍接线,于是接线本身的回归(去重时机、异常是否外抛)抓不到。
 *
 * 四条不变量:
 *
 *   1. **完成状态以「确实发出过评论」为准,不以「没抛异常」为准。**
 *      早先版本把 dispatch 不抛异常当作成功,于是三条路径都会静默丢任务:回帖
 *      失败被 catch 吞掉、media-only 回复没有文本可发、dispatch 之前的早返回
 *      (resolveAgentRoute 抛错、能力门禁)根本不是异常。三者都会写入持久去重
 *      并 ack —— 评论区静默、永不重试。现在由本函数统计真实投递次数来判定。
 *
 *   2. 只有真的投递过才写持久去重(complete);否则 release,让 server 侧重投
 *      仍能重放。兜底评论不计入投递 —— 它只保证有痕迹,不代表任务做成了。
 *
 *   3. 异常不外抛。外抛会让轮询器游标停在原地,重投后再次失败,形成每个轮询周期
 *      一次的死循环。代价要说清楚:ack 即 server 的 confirm,ack 过的事件不会
 *      再投,所以此处的 release 只对「ack 之前进程就没了」的情况有意义。选择
 *      收敛而不是死循环,并用不变量 1/2 保证失败一定留下痕迹。
 *
 *   4. 事件指向别的 bot 时在 claim 之前丢弃,避免用外部 bot 的 key 污染去重存储。
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

    // 只统计**成功**的投递:抛错的那次不计,于是「回帖失败」不会被当成交付。
    let delivered = 0;
    const postWithRetry = async (text: string, signal?: AbortSignal): Promise<void> => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
        try {
          await deps.postComment(mention, text, signal);
          delivered += 1;
          return;
        } catch (err) {
          lastErr = err;
          deps.log?.error?.(
            `octo: doc comment post failed (attempt ${attempt}/${POST_ATTEMPTS}) doc=${mention.docId}: ${String(err)}`,
          );
          if (attempt < POST_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, POST_RETRY_BASE_MS * attempt));
          }
        }
      }
      throw lastErr;
    };

    try {
      await deps.dispatch(synthesizeDocMentionMessage(mention, deps.botUid), undefined, {
        queueScope: docTaskQueueScope(mention),
        docTask: {
          docId: mention.docId,
          threadId: mention.threadId,
          sessionScope: docTaskSessionScope(mention),
          postComment: postWithRetry,
        },
      });
    } catch (err) {
      deps.log?.error?.(
        `octo: doc task dispatch failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
      );
    }

    if (delivered === 0) {
      // 本轮什么都没发到评论区 —— 无论原因是回帖失败、无文本可发,还是 dispatch
      // 之前就返回了。补一条兜底,保证用户在他看的地方看得到结果。
      try {
        await postWithRetry(NOTHING_DELIVERED_NOTICE);
      } catch (err) {
        deps.log?.error?.(
          `octo: doc task fallback notice failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
        );
      }
      // 兜底不算成功交付:不写持久去重,让 server 重投仍可重放。
      deps.dedupe.release(mention.idempotencyKey);
      return;
    }

    await deps.dedupe.complete(mention.idempotencyKey);
  };
}

export { docCommentParentId };
