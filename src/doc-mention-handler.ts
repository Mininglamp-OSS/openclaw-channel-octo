import { docTaskQueueScope, docTaskSessionScope, synthesizeDocMentionMessage, type DocCommentMention } from "./doc-mention.js";
import type { DocMentionDedupeStore } from "./doc-mention-dedupe.js";
import type { BotMessage } from "./types.js";
import { isPermanentDocCommentFailure } from "./api-fetch.js";

/**
 * 一个回合到底发生了什么。**由跑这个回合的人如实上报四个事实,不预先归纳成结论。**
 *
 * 为什么是四个布尔而不是一个三值枚举:枚举的值域表达不了「活儿落地了 **并且**
 * 另外出了岔子」——答复发出去之后再超时、再抛错,都是这一类。四轮评审里每一轮都
 * 有一个这种状态被硬塞进 work-delivered / notice-only / nothing 之一,每次塞错一个
 * 不同的。把事实原样交上来,由 handler 定策略,这类状态就不再需要被压扁。
 *
 * 上报方只负责说事实,不负责下判断。
 */
export interface DocTaskTurnReport {
  /**
   * 本回合的**最终答复**已经发进评论区(不含进度/工具文本,也不含道歉)。
   *
   * 由出站收口在 `await postComment(...)` **resolve 之后**置位 —— 那里是唯一同时
   * 知道「这帖带的是不是最终产出」和「POST 成没成」的地方。在别处置位就必须再引入
   * 一个补偿条件,而补偿条件会过度触发(见 handler 里的说明)。
   */
  finalDelivered: boolean;
  /** 评论区收到过任何内容(进度、附件、最终答复、提示)。仅用于观测。 */
  delivered: boolean;
  /** 有内容重试耗尽仍没发出去。**仅供观测**,不参与完成判定。 */
  lost: boolean;
  /** 发出过提示:道歉 / 超时 / 会话冲突回执。 */
  noticed: boolean;
}

/** 什么都没发生 —— dispatch 之前就早返回的回合(能力门禁、路由解析失败)。 */
export const EMPTY_DOC_TASK_REPORT: DocTaskTurnReport = Object.freeze({
  finalDelivered: false,
  delivered: false,
  lost: false,
  noticed: false,
});

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
       * 回合结束时上报一次事实。**没上报按 EMPTY_DOC_TASK_REPORT 处理** ——
       * dispatch 之前的早返回(能力门禁、路由解析失败)根本走不到上报点,而那些
       * 回合确实什么都没产出。保守方向天然正确:不写去重,允许重投。
       *
       * 会话初始化冲突会重试,所以这里可能被调用多次。不同 attempt 的事实必须
       * 累计:后续 notice-only 不能覆盖此前已经落地的 final。
       */
      reportTurn: (report: DocTaskTurnReport) => void;
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
// 措辞刻意不说「没有产生任何修改」:走到这里时 agent 可能已经改过文档了(答复
// 发丢的情形),断言「没改过」是在撒谎。只说用户能验证的那一半 —— 没给出答复。
const NOTHING_DELIVERED_NOTICE = "⚠️ 本次文档任务没有给出答复。请稍后重试或重新 @ 我。";

/** 用户提示只占一个短窗口,不能按 postDocComment 的 30s 默认值阻塞串行 poller。 */
export const DOC_TASK_NOTICE_TIMEOUT_MS = 10_000;

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
 *   2. **回合只上报事实,本文件定策略,而且两个决定是分开的。**
 *      推断版连续四轮出错,形态一次比一次隐蔽:先是把兜底道歉记成产出;再是
 *      「发过进度 + 最后道歉」被顶成完成;最后是把结论压成三值枚举,导致
 *      「答复已送达、之后 dispatch 又抛错」无处安放而被判成 nothing。根因不是
 *      某个点标错,而是**值域表达不了「活儿落地了并且另外出了岔子」**。
 *      现在上报 DocTaskTurnReport 四个事实,本文件据此各自决定:
 *        - 写不写去重  ← 最终答复是否落地(workLanded)
 *        - 补不补兜底  ← 用户是否在干等(既无答复也无提示)
 *      两者互不牵连,所以「答复落地 + 事后道歉」既能写去重、又不会叠一条废话。
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
 *   5. 兜底提示只在**用户干等**时补发 —— 既没拿到答复,也没收到任何失败提示。
 *      已经有道歉或冲突回执时不再叠加,否则用户连着看两句废话。
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
          // 确定性失败(信封拒绝、4xx)重试不会变好 —— 只会在轮询器的串行循环里
          // 白烧三次 POST 和 600ms,而后面的兜底通知还要再烧一遍同样的三次。
          if (isPermanentDocCommentFailure(err)) break;
          // signal 在这次 POST 期间被 abort 了:再退避 200/400ms 纯属在串行的轮询
          // 循环里空耗 —— 循环顶部那道检查要到下一轮才生效,已经晚了。
          if (signal?.aborted) break;
          if (attempt < POST_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, POST_RETRY_BASE_MS * attempt));
          }
        }
      }
      throw lastErr;
    };

    let reported: DocTaskTurnReport | undefined;
    let outcome: "completed" | "dropped" = "dropped";
    try {
      outcome = await deps.dispatch(synthesizeDocMentionMessage(mention, deps.botUid), undefined, {
        queueScope: docTaskQueueScope(mention),
        docTask: {
          docId: mention.docId,
          threadId: mention.threadId,
          sessionScope: docTaskSessionScope(mention),
          postComment: postWithRetry,
          reportTurn: (value) => {
            reported = reported
              ? {
                  finalDelivered: reported.finalDelivered || value.finalDelivered,
                  delivered: reported.delivered || value.delivered,
                  lost: reported.lost || value.lost,
                  noticed: reported.noticed || value.noticed,
                }
              : value;
          },
        },
      });
    } catch (err) {
      deps.log?.error?.(
        `octo: doc task dispatch failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
      );
    }

    const report = reported ?? EMPTY_DOC_TASK_REPORT;

    // 两个**互相独立**的决定。上一版把它们压进一个三值枚举,于是
    // 「答复发出去了、之后 dispatch 又抛错」这种状态无处安放,被判成 nothing ——
    // 在正确答复下面又贴一条「没有完成、也没有产生任何修改,请重新 @ 我」,
    // 用户照做就把改文档的任务再跑一遍。
    //
    // 注意这里**不看** dispatch 返回的 completed/dropped:唯一返回 dropped 的路径是
    // 会话冲突,而那条路径由 channel.ts 自己上报(noticed),其余失败一律是 reject。
    // 拿 outcome 当完成条件等于把「抛错」误当成「没跑」,那正是上面那个 bug。

    // `finalDelivered` 由出站收口在 POST **成功之后**置位,所以它已经是「答复确实
    // 进了评论区」本身,不需要再用 `&& !lost` 去补偿。那个补偿是回合全局的:一次
    // 进度评论的瞬时 5xx 会否决掉一个确实落地的最终答复,于是在正确答复下面贴出
    // 「没有给出答复」并允许重放。`lost` 现在只作观测字段。
    /** 活儿落地了:最终答复确实进了评论区。 */
    const workLanded = report.finalDelivered;
    /** 用户在干等:既没拿到答复,也没收到任何失败提示。 */
    const userLeftHanging = !workLanded && !report.noticed;

    deps.log?.info?.(
      `octo: doc task doc=${mention.docId} thread=${mention.threadId} workLanded=${workLanded} ` +
        `final=${report.finalDelivered} delivered=${report.delivered} lost=${report.lost} noticed=${report.noticed} dispatch=${outcome}`,
    );

    if (userLeftHanging) {
      try {
        await postWithRetry(
          NOTHING_DELIVERED_NOTICE,
          AbortSignal.timeout(DOC_TASK_NOTICE_TIMEOUT_MS),
        );
      } catch (err) {
        deps.log?.error?.(
          `octo: doc task fallback notice failed doc=${mention.docId} thread=${mention.threadId}: ${String(err)}`,
        );
      }
    }

    if (workLanded) {
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

    deps.dedupe.release(mention.idempotencyKey);
  };
}
