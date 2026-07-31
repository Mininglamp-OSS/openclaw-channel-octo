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
  /** 已处理过返回 true;否则登记并返回 false(登记与判定是同一次原子操作)。 */
  claim(idempotencyKey: string): Promise<boolean>;
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
        if (cache.includes(idempotencyKey)) return true;
        // 先落盘、成功后才更新内存:反过来的话,persist 抛错时内存已记为「已处理」,
        // 而调用方收到异常会重试 —— 重试时被内存判定为重复,任务被永久静默丢弃。
        const next = [...cache, idempotencyKey];
        if (next.length > capacity) next.splice(0, next.length - capacity);
        await persist(next);
        cache = next;
        return false;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

/** 进程内实现,供测试与显式关闭持久化的场景使用。 */
export function createMemoryDocMentionDedupeStore(capacity = DEFAULT_CAPACITY): DocMentionDedupeStore {
  const keys: string[] = [];
  return {
    async claim(idempotencyKey: string): Promise<boolean> {
      if (!idempotencyKey) return false;
      if (keys.includes(idempotencyKey)) return true;
      keys.push(idempotencyKey);
      if (keys.length > capacity) keys.splice(0, keys.length - capacity);
      return false;
    },
  };
}
