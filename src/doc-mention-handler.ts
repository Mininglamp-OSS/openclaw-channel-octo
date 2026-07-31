import { docCommentParentId, docTaskQueueScope, docTaskSessionScope, synthesizeDocMentionMessage, type DocCommentMention } from "./doc-mention.js";
import type { DocMentionDedupeStore } from "./doc-mention-dedupe.js";
import type { BotMessage } from "./types.js";

/**
 * 一次评论投递的性质。
 *
 * - `work`   —— 任务产出(最终答复、进度、附件)。只有它能证明「活儿干了」。
 * - `notice` —— 纯留痕的提示(错误/超时/拒绝兜底)。保证评论区不静默,但**不**代表
 *               任务完成 —— 记成完成会吸收掉本该重投的那一次。
 *
 * 默认 `work`:漏传 kind 时判成产出,再由完成判定的其余两个条件
 * (outcome === "completed" 且 lost === 0)兜住,好过把真产出误记成提示。
 */
export type DocTaskPostKind = "work" | "notice";

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
      postComment: (text: string, signal?: AbortSignal, opts?: { kind?: DocTaskPostKind }) => Promise<void>;
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

/** 兜底评论:本轮评论区一点痕迹都没留下时补发,保证用户不是干等。 */
const NOTHING_DELIVERED_NOTICE = "⚠️ 本次文档任务没有完成，也没有产生任何修改。请稍后重试或重新 @ 我。";

/** 回帖的有界重试:docs 后端一次瞬时 5xx 不该让整条回复永久消失。 */
const POST_ATTEMPTS = 3;
const POST_RETRY_BASE_MS = 200;

/**
 * 本轮任务的产出结论。**由投递本身上报,不由「有没有抛异常」反推。**
 *
 * - `work-delivered` —— 任务跑完、产出全部送达 → 写入持久去重。
 * - `notice-only`    —— 活儿没干成,但评论区已有提示 → 不补发、不记完成,允许重投。
 * - `incomplete`     —— 评论区没有任何痕迹(或有产出发丢且无提示)→ 补发兜底,允许重投。
 */
type DocTaskResult = "work-delivered" | "notice-only" | "incomplete";

/**
 * 文档任务的接线逻辑。抽成独立函数是为了能被直接测试 —— 放在 startAccount 的闭包里
 * 时,测试只能重新实现一遍接线,于是接线本身的回归(去重时机、异常是否外抛)抓不到。
 *
 * 五条不变量:
 *
 *   1. **完成状态以「确实发出过产出」为准,不以「没抛异常」为准。**
 *      早先版本把 dispatch 不抛异常当作成功,于是三条路径都会静默丢任务:回帖
 *      失败被 catch 吞掉、media-only 回复没有文本可发、dispatch 之前的早返回
 *      (resolveAgentRoute 抛错、能力门禁)根本不是异常。三者都会写入持久去重
 *      并 ack —— 评论区静默、永不重试。
 *
 *   2. **产出与提示分开记账。** 兜底提示(kind: "notice")只保证留痕,不计入产出。
 *      否则一个「只发出一句道歉」的回合会被判成完成 —— 文档一个字没改,事件却被
 *      吸收掉。完成 = 任务跑完(completed) **且** 没有任何产出发丢 **且** 确实发出
 *      过产出。被判 dropped 的任务(如会话冲突)哪怕发过回执也不算完成。
 *
 *   3. 异常不外抛,**包括去重落盘失败**。外抛会让轮询器游标停在原地(events-poll.ts
 *      在 cursorStore.save 与 ack 之前 await 本函数),重投后再次失败,形成每个轮询
 *      周期一次的死循环 —— 而这是个会改文档的任务。代价要说清楚:ack 即 server 的
 *      confirm,ack 过的事件不会再投,所以此处的 release 只对「ack 之前进程就没了」
 *      的情况有意义。选择收敛而不是死循环,并用不变量 1/2 保证失败一定留下痕迹。
 *
 *   4. 事件指向别的 bot 时在 claim 之前丢弃,避免用外部 bot 的 key 污染去重存储。
 *
 *   5. 兜底提示只在**评论区一点痕迹都没有**时补发。inbound 侧的道歉本身已经是一条
 *      notice,再补一条通用兜底等于让用户连着看两句废话。
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

    // 「投递过」不等于「答复送达」:一个回合可能先发成功一条进度消息、再把最终
    // 答复发丢。只看 delivered>0 会把这种情况判成成功 —— 用户只看到「正在读取
    // 文档…」,永远等不到答复,也等不到失败提示。所以同时记丢失次数。
    let delivered = 0;
    let lost = 0;
    let noticed = false;
    const postWithRetry = async (
      text: string,
      signal?: AbortSignal,
      opts?: { kind?: DocTaskPostKind },
    ): Promise<void> => {
      const kind = opts?.kind ?? "work";
      let lastErr: unknown;
      for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
        // 已 abort 就别再退避重试:调用方(超时兜底)给的本来就是短超时 signal,
        // 继续睡只会把整个回合再拖长 POST_RETRY_BASE_MS * n。
        if (signal?.aborted) {
          lastErr ??= new Error(`octo: doc comment post aborted before attempt ${attempt}`);
          break;
        }
        try {
          await deps.postComment(mention, text, signal);
          if (kind === "work") delivered += 1;
          else noticed = true;
          return;
        } catch (err) {
          lastErr = err;
          deps.log?.error?.(
            `octo: doc comment post failed (attempt ${attempt}/${POST_ATTEMPTS}, kind=${kind}) doc=${mention.docId}: ${String(err)}`,
          );
          if (attempt < POST_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, POST_RETRY_BASE_MS * attempt));
          }
        }
      }
      if (kind === "work") lost += 1;
      throw lastErr;
    };

    let outcome: "completed" | "dropped" = "dropped";
    try {
      outcome = await deps.dispatch(synthesizeDocMentionMessage(mention, deps.botUid), undefined, {
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

    const result: DocTaskResult =
      outcome === "completed" && lost === 0 && delivered > 0
        ? "work-delivered"
        : noticed
          ? "notice-only"
          : "incomplete";

    deps.log?.info?.(
      `octo: doc task result=${result} doc=${mention.docId} thread=${mention.threadId} delivered=${delivered} lost=${lost} noticed=${noticed} outcome=${outcome}`,
    );

    if (result === "work-delivered") {
      try {
        await deps.dedupe.complete(mention.idempotencyKey);
      } catch (err) {
        // 不变量 3:活儿干完了、答复也送达了,此时丢的只是去重记录。事件随后会被
        // ack,server 不会再投,所以放过它;外抛会卡住游标并把改文档的任务重跑一遍。
        deps.log?.error?.(
          `octo: doc mention dedupe persist failed key=${mention.idempotencyKey} doc=${mention.docId}: ${String(err)}`,
        );
      }
      return;
    }

    if (result === "incomplete") {
      try {
        // kind:"notice" —— 兜底只保证留痕,不代表任务做成,不计入产出。
        await postWithRetry(NOTHING_DELIVERED_NOTICE, undefined, { kind: "notice" });
      } catch (err) {
        deps.log?.error?.(
          `octo: doc task fallback notice failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
        );
      }
    }
    deps.dedupe.release(mention.idempotencyKey);
  };
}

export { docCommentParentId };
