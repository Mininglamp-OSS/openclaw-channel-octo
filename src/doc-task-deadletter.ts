// 文档任务的**死信记录**。
//
// 为什么需要它 —— 存在一个「已 ack 但用户什么都没收到」的窗口:
//   1. 轮询器为了不重放非幂等的改文档任务,处理完就推进游标并 ack(events-poll.ts)。
//   2. 但「处理完」不等于「用户看到了」:最终答复的 POST 可能三次全失败,随后的
//      兜底通知(NOTHING_DELIVERED_NOTICE)也可能三次全失败 —— 评论区服务不可用时
//      这两件事是同因的,大概率一起失败。
//   3. 此时事件已被 ack,server 不再投递。原先这里只写一行 log 就返回,任务从此
//      在系统里不存在了:用户在评论区干等,没有任何一侧留下可查的记录。
//
// 所以在那个分支落一条持久记录。它**不是重投队列** —— 重投一个会改文档的任务不幂等,
// 那正是 ack 提前的原因;这里要的是「可查」,让运维能回答「那条 @Bot 到底怎么了」。
//
// 与去重表刻意分开两个文件:去重表是热路径、按 capacity 滚动淘汰,死信要留得久一点,
// 且它写失败时绝不能影响去重表的写入。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CHANNEL_ID = "octo";
const DEFAULT_CAPACITY = 200;

export interface DocTaskDeadLetter {
  /** 事件的幂等键 —— 与去重表同一个键,便于交叉对照。 */
  idempotencyKey: string;
  docId: string;
  threadId: string;
  /** ISO 时间戳。 */
  at: string;
  /**
   * 为什么进死信。目前只有一种:answer 与兜底通知都没能送达。
   * 保留成字段而不是隐含,是为了以后新增分类时旧记录仍可解释。
   */
  reason: "undelivered_after_ack";
  /** 最后一次 POST 的错误摘要(已截断)。 */
  detail?: string;
}

export interface DocTaskDeadLetterStore {
  /** 记一条。**绝不抛** —— 调用点在失败收尾路径上,再抛就把游标一起卡住。 */
  record(entry: DocTaskDeadLetter): Promise<void>;
  /** 读全部(运维/测试用)。 */
  list(): Promise<DocTaskDeadLetter[]>;
}

interface DeadLetterFile {
  entries?: unknown;
}

const DETAIL_MAX = 500;

function normalizeAccountId(accountId: string): string {
  return accountId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_") || "default";
}

/** detail 截断:错误串可能带整段 stack,死信文件不该被一条记录撑爆。 */
export function truncateDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX)}…` : trimmed;
}

export function createFileDocTaskDeadLetterStore(params: {
  accountId: string;
  baseDir?: string;
  capacity?: number;
  log?: { error?: (message: string) => void };
}): DocTaskDeadLetterStore {
  const capacity = Math.max(1, Math.floor(params.capacity ?? DEFAULT_CAPACITY));
  const baseDir = params.baseDir ?? join(homedir(), ".openclaw", "workspace", CHANNEL_ID);
  const dir = join(baseDir, normalizeAccountId(params.accountId));
  const file = join(dir, "doc-tasks.deadletter.json");

  // 串行化读-改-写(rename 原子,读改写不是)。与去重表同样的单进程假设。
  let tail: Promise<void> = Promise.resolve();

  const read = async (): Promise<DocTaskDeadLetter[]> => {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as DeadLetterFile;
      if (!Array.isArray(raw.entries)) return [];
      return raw.entries
        .filter((e): e is DocTaskDeadLetter =>
          !!e &&
          typeof e === "object" &&
          typeof (e as DocTaskDeadLetter).idempotencyKey === "string" &&
          typeof (e as DocTaskDeadLetter).at === "string",
        )
        .slice(-capacity);
    } catch {
      // 文件不存在 / 内容损坏:当空表。死信是观测设施,不能因为自己读不动就影响主流程。
      return [];
    }
  };

  return {
    async record(entry) {
      const run = tail.then(async () => {
        try {
          const entries = await read();
          entries.push({ ...entry, detail: truncateDetail(entry.detail) });
          await mkdir(dir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          await writeFile(tmp, JSON.stringify({ entries: entries.slice(-capacity) }), "utf8");
          await rename(tmp, file);
        } catch (err) {
          // ★ 吞掉并记账。调用点是「answer 和通知都没送出去」的收尾路径:
          // 在那里抛异常会逃出轮询器的处理段,把游标卡住并让改文档的任务重放 ——
          // 用一个观测设施的失败换一次非幂等重跑,不成立。
          params.log?.error?.(
            `octo: doc task dead-letter write failed key=${entry.idempotencyKey} doc=${entry.docId}: ${String(err)}`,
          );
        }
      });
      tail = run;
      await run;
    },
    async list() {
      return read();
    },
  };
}

/** 内存实现(测试 / 未配置状态目录时)。容量同样有界,避免长跑进程无界增长。 */
export function createMemoryDocTaskDeadLetterStore(capacity = DEFAULT_CAPACITY): DocTaskDeadLetterStore {
  const cap = Math.max(1, Math.floor(capacity));
  const entries: DocTaskDeadLetter[] = [];
  return {
    async record(entry) {
      entries.push({ ...entry, detail: truncateDetail(entry.detail) });
      if (entries.length > cap) entries.splice(0, entries.length - cap);
    },
    async list() {
      return [...entries];
    },
  };
}
