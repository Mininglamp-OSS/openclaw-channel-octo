import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeAccountId } from "./account-id.js";
import { CHANNEL_ID } from "./constants.js";

const DEFAULT_CAPACITY = 500;

/**
 * 文档任务的持久去重。
 *
 * 为什么必须持久化:轮询器是「先执行、后存游标」(events-poll.ts),进程在执行中崩溃
 * 会导致同一事件被重新拉取;octo-server 侧也明说 enqueue 后 confirm 前崩溃会重投
 * (modules/bot_mention/api.go 的 confirm 注释)。两条路径都靠消费端按
 * idempotency_key 去重收敛,只放在内存里会被进程重启击穿。
 */
export interface DocMentionDedupeStore {
  /**
   * 已完成过、或本进程内正在处理 → true(跳过);否则标记为「进行中」并返回 false。
   *
   * 「进行中」只存在内存里,刻意不落盘:落盘就意味着崩溃重启后该事件被判定为已处理,
   * 而此时任务其实一次都没跑完 —— 文档没改、评论区无反馈、日志只写一行
   * 「already processed」。磁盘只记完成态,崩溃后自然允许重放。
   */
  claim(idempotencyKey: string): Promise<boolean>;
  /** 任务成功收尾:写入磁盘,此后跨进程去重。 */
  complete(idempotencyKey: string): Promise<void>;
  /** 任务未完成:撤销「进行中」标记,允许后续重投再次执行。 */
  release(idempotencyKey: string): void;
}

interface DedupeFile {
  keys?: unknown;
}

export function createFileDocMentionDedupeStore(params: {
  accountId: string;
  baseDir?: string;
  capacity?: number;
}): DocMentionDedupeStore {
  const capacity = Math.max(1, Math.floor(params.capacity ?? DEFAULT_CAPACITY));
  const baseDir = params.baseDir ?? join(homedir(), ".openclaw", "workspace", CHANNEL_ID);
  const dir = join(baseDir, normalizeAccountId(params.accountId));
  const file = join(dir, "doc-mentions.processed.json");

  let loaded: Promise<string[]> | undefined;
  let cache: string[] | undefined;
  const inFlight = new Set<string>();
  // 串行化写入,避免同账号并发任务互相覆盖(rename 是原子的,但读-改-写不是)。
  let tail: Promise<void> = Promise.resolve();

  const load = async (): Promise<string[]> => {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as DedupeFile;
      return Array.isArray(raw.keys)
        ? raw.keys.filter((key): key is string => typeof key === "string").slice(-capacity)
        : [];
    } catch {
      return [];
    }
  };

  const persist = async (keys: string[]): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.doc-mentions.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, `${JSON.stringify({ keys })}\n`, "utf8");
    await rename(tmp, file);
  };

  return {
    async claim(idempotencyKey: string): Promise<boolean> {
      if (!idempotencyKey) return false;
      const run = tail.then(async () => {
        loaded ??= load();
        cache ??= await loaded;
        if (cache.includes(idempotencyKey) || inFlight.has(idempotencyKey)) return true;
        inFlight.add(idempotencyKey);
        return false;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },

    async complete(idempotencyKey: string): Promise<void> {
      if (!idempotencyKey) return;
      const run = tail.then(async () => {
        loaded ??= load();
        cache ??= await loaded;
        if (cache.includes(idempotencyKey)) { inFlight.delete(idempotencyKey); return; }
        // 先落盘、成功后才更新内存:反过来的话,persist 抛错时内存已记为「已完成」,
        // 而调用方仍会重试 —— 重试时被内存判定为重复,任务被永久静默丢弃。
        const next = [...cache, idempotencyKey];
        if (next.length > capacity) next.splice(0, next.length - capacity);
        await persist(next);
        cache = next;
        inFlight.delete(idempotencyKey);
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },

    release(idempotencyKey: string): void {
      inFlight.delete(idempotencyKey);
    },
  };
}

/** 进程内实现,供测试与显式关闭持久化的场景使用。 */
export function createMemoryDocMentionDedupeStore(capacity = DEFAULT_CAPACITY): DocMentionDedupeStore {
  const keys: string[] = [];
  const inFlight = new Set<string>();
  return {
    async claim(idempotencyKey: string): Promise<boolean> {
      if (!idempotencyKey) return false;
      if (keys.includes(idempotencyKey) || inFlight.has(idempotencyKey)) return true;
      inFlight.add(idempotencyKey);
      return false;
    },
    async complete(idempotencyKey: string): Promise<void> {
      if (!idempotencyKey) return;
      inFlight.delete(idempotencyKey);
      if (keys.includes(idempotencyKey)) return;
      keys.push(idempotencyKey);
      if (keys.length > capacity) keys.splice(0, keys.length - capacity);
    },
    release(idempotencyKey: string): void { inFlight.delete(idempotencyKey); },
  };
}
