import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeAccountId } from "./account-id.js";
import { ackBotEvent, fetchBotEvents } from "./api-fetch.js";
import { CHANNEL_ID } from "./constants.js";
import { parseCardAction, type CardAction } from "./card-action.js";
import { parseDocCommentMention, type DocCommentMention } from "./doc-mention.js";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_LIMIT = 50;

export interface EventCursorStore {
  load(): Promise<number>;
  save(eventId: number): Promise<void>;
}

export function createFileEventCursorStore(params: {
  accountId: string;
  baseDir?: string;
}): EventCursorStore {
  const baseDir = params.baseDir ?? join(homedir(), ".openclaw", "workspace", CHANNEL_ID);
  const dir = join(baseDir, normalizeAccountId(params.accountId));
  const file = join(dir, "events.cursor.json");
  return {
    async load(): Promise<number> {
      try {
        const raw = JSON.parse(await readFile(file, "utf8")) as { event_id?: unknown };
        return typeof raw.event_id === "number" && Number.isSafeInteger(raw.event_id) && raw.event_id >= 0
          ? raw.event_id
          : 0;
      } catch {
        return 0;
      }
    },
    async save(eventId: number): Promise<void> {
      if (!Number.isSafeInteger(eventId) || eventId < 0) {
        throw new Error(`invalid event cursor: ${eventId}`);
      }
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.events.cursor.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(tmp, `${JSON.stringify({ event_id: eventId })}\n`, "utf8");
      await rename(tmp, file);
    },
  };
}

export interface EventPollerOptions {
  apiUrl: string;
  botToken: string;
  cursorStore: EventCursorStore;
  onCardAction?: (action: CardAction) => void | Promise<void>;
  /** 文档评论 @Bot 任务(octo-server `doc_comment_mention`)。未提供则该类事件不被识别。 */
  onDocMention?: (mention: DocCommentMention) => void | Promise<void>;
  intervalMs?: number;
  limit?: number;
  ack?: boolean;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}

export interface EventPoller {
  ready: Promise<void>;
  stop(): void;
  cursor(): number;
}

const pollStarters = new Map<string, () => void>();

export function setCardEventPollStarter(accountId: string, starter: (() => void) | undefined): void {
  const id = normalizeAccountId(accountId);
  if (starter) pollStarters.set(id, starter);
  else pollStarters.delete(id);
}

export function requestCardEventPolling(accountId: string): void {
  pollStarters.get(normalizeAccountId(accountId))?.();
}

/**
 * Start one non-overlapping short-poll loop. Cursor persistence happens before ack so a process
 * crash can at worst replay an action; it cannot acknowledge an event that it forgot locally.
 */
export function startEventPoller(options: EventPollerOptions): EventPoller {
  const intervalMs = Math.max(500, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  let cursor = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const events = await fetchBotEvents({
        apiUrl: options.apiUrl,
        botToken: options.botToken,
        sinceEventId: cursor,
        limit,
      });
      // Validate ids *before* sorting: a non-integer event_id makes numeric-subtraction comparison
      // return NaN, which leaves the sort order unspecified and can drop a valid interleaved event.
      const malformed = events.filter((event) => !Number.isSafeInteger(event.event_id)).length;
      if (malformed > 0) {
        options.log?.error?.(`octo: event poll dropped ${malformed} event(s) with a non-integer event_id`);
      }
      let cardActions = 0;
      let docMentions = 0;
      const ordered = events
        .filter((event) => Number.isSafeInteger(event.event_id) && event.event_id > cursor)
        .sort((a, b) => a.event_id - b.event_id);
      for (const event of ordered) {
        // 已识别的事件才 ack。未识别的只推进游标(本消费者不再重复拉取),
        // 留在服务端直至过期 —— 不 ack 自己没处理的事件。
        let recognized = false;
        const action = options.onCardAction ? parseCardAction(event) : null;
        if (action) {
          recognized = true;
          cardActions += 1;
          // 卡片动作**故意**让异常逃出去:不存游标、不 ack,下一轮重取同一事件。
          // 卡片动作是幂等的即时响应,重放的代价只是再回一次;这条语义由
          // events-poll.test.ts 钉住,不要顺手改。
          await options.onCardAction!(action);
        } else if (options.onDocMention) {
          const mention = parseDocCommentMention(event);
          if (mention) {
            recognized = true;
            docMentions += 1;
            // 文档任务相反,异常绝不能逃出去。下面的 cursorStore.save 和 ack 都排在
            // handler 之后,异常逃出去就等于「不存游标、不 ack」,下一 tick 原样重取
            // —— 而这是个会改文档、会往评论区发言的任务,重放不幂等:实测每个轮询
            // 周期重跑一次,3.2s 内跑了 6 遍,永不收敛。handler 自己承诺不抛(见
            // doc-mention-handler.ts 不变量 3),这里是轮询器侧的兜底,不依赖它。
            try {
              await options.onDocMention(mention);
            } catch (error) {
              options.log?.error?.(
                `octo: doc mention handler threw for event ${event.event_id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }

        // ACK 先于存游标,而且存游标不许抛。
        //
        // 两者是不同量级的失败:ack 才是真正止住 server 重投的东西,游标只是本进程
        // 的重启起点 —— 已 ack 的事件 server 不会再投,所以游标丢了是可恢复的。
        // 反过来写就不成立:游标存在轮询器状态目录里(events.cursor.json),和文档
        // 任务的去重表(doc-mentions.processed.json)是**同一个目录**,EROFS /
        // ENOSPC / EACCES / EDQUOT 会同时命中两处写。原先 save() 裸在这里,一抛就
        // 逃出整个 for 循环:不 ack、游标不前进(它在 save 之后才赋值)、批次剩下
        // 的事件也一起不处理 —— 下一 tick 原样重取,把会改文档的任务每周期重跑
        // 一遍,同时把卡片动作也一并楔死。实测 3.2s 跑 6 遍,永不收敛。
        if (recognized && options.ack !== false) {
          try {
            await ackBotEvent({
              apiUrl: options.apiUrl,
              botToken: options.botToken,
              eventId: event.event_id,
            });
          } catch (error) {
            options.log?.error?.(
              `octo: ack event ${event.event_id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        try {
          await options.cursorStore.save(event.event_id);
        } catch (error) {
          options.log?.error?.(
            `octo: cursor save failed at event ${event.event_id} (in-memory cursor still advances): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // 内存游标无条件前进:落盘失败只影响重启后的起点,不该让本进程反复重取。
        cursor = event.event_id;
      }
      if (events.length > 0) {
        options.log?.info?.(
          `octo: event poll batch events=${events.length} card_actions=${cardActions} doc_mentions=${docMentions} cursor=${cursor}`,
        );
      }
    } catch (error) {
      options.log?.error?.(
        `octo: event poll failed at cursor=${cursor}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      schedule();
    }
  };

  const ready = options.cursorStore.load()
    .then((loaded) => {
      cursor = Number.isSafeInteger(loaded) && loaded >= 0 ? loaded : 0;
      options.log?.info?.(`octo: bot event poller ready at cursor=${cursor}`);
      schedule();
    })
    .catch((error) => {
      options.log?.error?.(
        `octo: event cursor load failed, starting from zero: ${error instanceof Error ? error.message : String(error)}`,
      );
      cursor = 0;
      schedule();
    });

  return {
    ready,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    cursor(): number {
      return cursor;
    },
  };
}
