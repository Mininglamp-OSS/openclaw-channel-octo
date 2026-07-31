import { docTaskQueueScope, docTaskSessionScope, synthesizeDocMentionMessage, type DocCommentMention } from "./doc-mention.js";
import type { DocMentionDedupeStore } from "./doc-mention-dedupe.js";
import type { BotMessage } from "./types.js";

/**
 * 一个回合的产出结论。**由跑这个回合的人上报,不由本文件从副作用推断。**
 *
 * - `work-delivered` —— 真实产出送达,且这一回合没有发生任何需要道歉的事。
 * - `notice-only`    —— 活儿没干成,但评论区已有提示(道歉/超时/冲突回执)。
 * - `nothing`        —— 评论区没有任何痕迹,或有产出发丢且没来得及提示。
 *
 * 为什么是上报而不是推断:上一版让 handler 从 delivered/lost/noticed 三个计数器
 * 重建结论,于是每个出站点都得记得给自己打对标签 —— 连续三轮都有某个点标错。
 * 只有跑完整个回合的 inbound 才同时知道「答复发出去没有」和「中间道歉过没有」,
 * 结论就该由它说一次,而不是让别处拼。
 */
export type DocTaskOutcome = "work-delivered" | "notice-only" | "nothing";

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
      /**
       * 回合结束时恰好上报一次。**没上报按 `nothing` 处理** —— dispatch 之前的
       * 早返回(能力门禁、路由解析失败)根本走不到上报点,而那些回合确实什么都
       * 没产出。保守方向天然正确:不写去重,允许重投。
       */
      reportOutcome: (outcome: DocTaskOutcome) => void;
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
 *   2. **结论由回合自己上报(reportOutcome),本文件不从副作用推断。**
 *      推断版连续三轮出错,每次都是某个出站点忘了给自己打标:第一次把兜底道歉
 *      记成产出;第二次修成「delivered === 0 且发过提示」才算未完成,漏了
 *      「发过进度 + 最后道歉」——一条「正在读取文档…」就能把这种回合顶成完成。
 *      根因是判定散落在各调用点。现在只有跑完整个回合的 inbound 说一次:它同时
 *      知道答复发出去没有、以及中间道歉过没有。**道歉过的回合一律不算完成。**
 *      被判 dropped 的任务(如会话冲突)哪怕上报了产出也不算完成 —— 活儿没干。
 *
 *   3. 异常不外抛,**包括去重落盘失败**。events-poll.ts 在 ack 之前 await 本函数,
 *      外抛就等于不 ack,重投后再次失败,形成每个轮询周期一次的死循环 —— 而这是个
 *      会改文档的任务。(轮询器侧也有一层兜底,两边都堵是因为磁盘故障会同时命中
 *      去重表和游标文件这两处写,只堵一处修不干净。)代价要说清楚:ack 即 server 的
 *      confirm,ack 过的事件不会再投,所以此处的 release 只对「ack 之前进程就没了」
 *      的情况有意义。选择收敛而不是死循环,并用不变量 1/2 保证失败一定留下痕迹。
 *
 *   4. 事件指向别的 bot 时在 claim 之前丢弃,避免用外部 bot 的 key 污染去重存储。
 *
 *   5. 兜底提示只在结论为 `nothing`(评论区一点痕迹都没有)时补发。`notice-only`
 *      说明道歉/回执已经在评论区了,再补一条通用兜底等于让用户连着看两句废话。
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

    const postWithRetry = async (text: string, signal?: AbortSignal): Promise<void> => {
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

    let reported: DocTaskOutcome | undefined;
    let outcome: "completed" | "dropped" = "dropped";
    try {
      outcome = await deps.dispatch(synthesizeDocMentionMessage(mention, deps.botUid), undefined, {
        queueScope: docTaskQueueScope(mention),
        docTask: {
          docId: mention.docId,
          threadId: mention.threadId,
          sessionScope: docTaskSessionScope(mention),
          postComment: postWithRetry,
          reportOutcome: (value) => { reported = value; },
        },
      });
    } catch (err) {
      deps.log?.error?.(
        `octo: doc task dispatch failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
      );
    }

    // 上报的结论是权威,但「任务真的跑完了」仍由 dispatch 说了算:被判 dropped 的
    // 回合(会话冲突)根本没执行,哪怕上报了产出也不能算完成 —— 记为完成会吸收掉
    // 本该重投的那一次。
    const result: DocTaskOutcome =
      reported === undefined
        ? "nothing"
        : reported === "work-delivered" && outcome !== "completed"
          ? "nothing"
          : reported;

    deps.log?.info?.(
      `octo: doc task result=${result} doc=${mention.docId} thread=${mention.threadId} reported=${reported ?? "none"} outcome=${outcome}`,
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

    if (result === "nothing") {
      try {
        await postWithRetry(NOTHING_DELIVERED_NOTICE);
      } catch (err) {
        deps.log?.error?.(
          `octo: doc task fallback notice failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
        );
      }
    }
    deps.dedupe.release(mention.idempotencyKey);
  };
}
