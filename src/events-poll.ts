import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeAccountId } from "./account-id.js";
import {
  ackBotEvent,
  eventsPollTimeoutMs,
  fetchBotEvents,
  MAX_EVENT_WAIT_SECONDS,
  MIN_EVENT_WAIT_SECONDS,
} from "./api-fetch.js";
import { CHANNEL_ID } from "./constants.js";
import { parseCardAction, type CardAction } from "./card-action.js";
import { invalidateBotCardProfile } from "./card-profile-cache.js";
import { parseDocCommentMention, type DocCommentMention } from "./doc-mention.js";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_LIMIT = 50;
/** Ceiling for the error backoff in long-poll mode. */
const MAX_ERROR_BACKOFF_MS = 30_000;
/**
 * How much of the requested hold a response must have consumed for the server to count as
 * "actually holding". Well below 1 so ordinary jitter, or a hold ended early by a real event
 * arriving, is not mistaken for a non-holding server.
 */
const HELD_FRACTION = 0.5;

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
  /**
   * Seconds to let the server hold an empty queue open (its `wait` parameter).
   *
   * Unset or 0 keeps the historical short-poll loop: one read per `intervalMs`. When set, the
   * server supplies the pacing — it only answers early once an event lands — so the loop stops
   * adding `intervalMs` of dead time between reads, which would otherwise eat much of the
   * latency the hold just bought.
   */
  waitSeconds?: number;
  ack?: boolean;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}

export interface EventPoller {
  ready: Promise<void>;
  stop(): void;
  cursor(): number;
}

const POLL_STARTERS_STATE_KEY = Symbol.for("openclaw.octo.card-event-poll-starters.v1");

function getPollStarters(): Map<string, () => void> {
  const root = process as unknown as Record<PropertyKey, unknown>;
  const existing = root[POLL_STARTERS_STATE_KEY] as Map<string, () => void> | undefined;
  if (existing) return existing;
  const created = new Map<string, () => void>();
  root[POLL_STARTERS_STATE_KEY] = created;
  return created;
}

// Channel and embedded agent runtimes may load separate module instances. Keep the lazy starters
// process-shared so any profile consumer can activate the owning account's event poller.
const pollStarters = getPollStarters();

export function setCardEventPollStarter(accountId: string, starter: (() => void) | undefined): void {
  const id = normalizeAccountId(accountId);
  if (starter) pollStarters.set(id, starter);
  else pollStarters.delete(id);
}

export function requestCardEventPolling(accountId: string): void {
  pollStarters.get(normalizeAccountId(accountId))?.();
}

/**
 * Start one non-overlapping poll loop, short-polling by default and long-polling when
 * `waitSeconds` is set.
 *
 * Ordering (two invariants, both load-bearing — do not collapse them):
 * 1. Cursor persistence is attempted **before** ack, so a process crash can at worst replay an
 *    action; it can never acknowledge an event it has already forgotten locally.
 * 2. That persistence is **not allowed to throw**. The cursor file (`events.cursor.json`) and the
 *    doc-task dedupe table (`doc-mentions.processed.json`) live in the **same** state directory, so
 *    EROFS / ENOSPC / EACCES / EDQUOT hit both writes at once. A bare `save()` here would escape
 *    the whole `for` loop: no ack, no cursor advance, remaining batch events dropped — re-fetching
 *    the same document-mutating task every tick (measured: polls=6 taskRuns=6 in 3.2s, never
 *    converging). So the failure is logged, the in-memory cursor still advances, and the ack
 *    attempt plus the rest of the batch still run.
 *
 * Fetching is cursor-driven; ack additionally asks the server to prune an accepted event but is
 * not assumed to be the sole durability guarantee. After a restart, a stale on-disk cursor may
 * re-fetch a doc event; the persistent dedupe table converges it.
 */
export function startEventPoller(options: EventPollerOptions): EventPoller {
  const intervalMs = Math.max(500, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  // Clamp at runtime, not just in the JSON schema: a host that surfaces the schema advisorily
  // rather than enforcing it would otherwise let eventWaitSeconds: 3600 through, yielding a
  // ~3610s client timeout against a server that clamps its own `wait` to 30s.
  //
  // The lower bound matters just as much and is less obvious: a hold shorter than
  // MIN_EVENT_WAIT_SECONDS makes idle traffic *worse* than the short polling it replaces, and
  // narrows the "did the server hold?" guard below a normal slow RTT, so a non-holding server
  // gets misread as holding. Raise rather than reject — the operator asked for long polling and
  // gets the shortest hold that actually delivers it. `Math.round` so 0.5 does not silently
  // become 0 (which would disable the feature with no signal at all).
  const requestedWait = options.waitSeconds ?? 0;
  const waitSeconds =
    requestedWait > 0
      ? Math.min(MAX_EVENT_WAIT_SECONDS, Math.max(MIN_EVENT_WAIT_SECONDS, Math.round(requestedWait)))
      : 0;
  if (requestedWait > 0 && waitSeconds !== Math.round(requestedWait)) {
    options.log?.info?.(
      `octo: eventWaitSeconds ${requestedWait} clamped to ${waitSeconds} ` +
        `(valid range ${MIN_EVENT_WAIT_SECONDS}-${MAX_EVENT_WAIT_SECONDS}; 0 disables long polling)`,
    );
  }
  let cursor = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Tracks the in-flight request so stop() can cut a hold short. Without this the loop is a
  // single sequential chain, so a stop during a 25s hold would keep the account busy for the
  // rest of that hold instead of shutting down.
  let inFlight: AbortController | undefined;
  let consecutiveErrors = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), Math.max(0, delayMs));
  };

  /**
   * Pace the next tick from what this one actually did.
   *
   * Long polling delegates pacing to the server — but only while the server is really holding.
   * Rescheduling at 0ms unconditionally (the first version of this) turns any fast return into a
   * hot loop: an older server that ignores `wait`, any 4xx/5xx, a connection refusal, or a proxy
   * closing the hold early all come back in one RTT, and the loop re-fires immediately, forever.
   * Measured at ~800 req/s against an immediately-erroring server — the opposite of the traffic
   * reduction this feature exists for, at exactly the moment the server can least absorb it.
   *
   * So: only a hold that was genuinely honoured earns an immediate re-poll.
   */
  const nextDelayMs = (
    outcome: "batch" | "empty" | "error",
    requestMs: number,
  ): number => {
    if (outcome === "error") {
      // Never hammer an unhealthy server. Exponential, capped, reset on any success.
      //
      // This applies to short polling too, and that matters more than it used to. Short poll
      // (`eventWaitSeconds` unset, the default) used to return `intervalMs` here unconditionally,
      // so a poller pointed at an unhealthy or unauthorized events endpoint kept its ~2s cadence
      // forever — one request and one `event poll failed at cursor=` line every tick, on the
      // order of 43k of each per account per day. That was tolerable while the resident poller
      // only ran for accounts that had opted into `docTasks`; now that doc tasks default to on,
      // every account has one, so the failure mode would scale with the account count.
      // Backing off is strictly a reduction: on a healthy server no error occurs and pacing is
      // untouched, and the counter resets on the first success, so a transient blip costs at
      // most a few slower ticks before the ~2s cadence returns.
      consecutiveErrors += 1;
      return Math.min(MAX_ERROR_BACKOFF_MS, intervalMs * 2 ** (consecutiveErrors - 1));
    }
    consecutiveErrors = 0;
    if (waitSeconds === 0) return intervalMs; // short poll: success pacing unchanged
    // Events in hand: drain immediately, there may be more behind them.
    if (outcome === "batch") return 0;
    // Empty, and the server clearly did not hold for anything like the time we asked for — it is
    // not participating in the long poll (old server, proxy, or an error page). Fall back to
    // client-side pacing rather than spinning.
    if (requestMs < waitSeconds * 1000 * HELD_FRACTION) return intervalMs;
    // Empty after a real hold: the server did its job, go straight back in.
    return 0;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const startedAt = Date.now();
    let outcome: "batch" | "empty" | "error" = "empty";
    try {
      const controller = new AbortController();
      inFlight = controller;
      const timeoutSignal = AbortSignal.timeout(eventsPollTimeoutMs(waitSeconds));
      const events = await fetchBotEvents({
        apiUrl: options.apiUrl,
        botToken: options.botToken,
        sinceEventId: cursor,
        limit,
        ...(waitSeconds > 0 ? { waitSeconds } : {}),
        // Combine both reasons to give up: the ordinary per-request timeout, and an explicit
        // stop. Passing a signal suppresses the default timeout inside fetchBotEvents, so the
        // timeout has to be supplied here rather than relying on it.
        signal: AbortSignal.any([controller.signal, timeoutSignal]),
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
        if (event.event_type === "bot_setting_updated" &&
            event.event_data?.scope === "bot_setting") {
          invalidateBotCardProfile({ apiUrl: options.apiUrl, botToken: options.botToken });
        }

        // 落盘游标**排在 ack 之前**(保留 main 的不变量):进程崩溃最坏是重放一次动作,
        // 绝不会 ack 掉一个本地已经忘掉的事件。
        //
        // 但落盘**不许抛**(本 PR 补的第二个不变量):游标文件(events.cursor.json)和文档
        // 任务的去重表(doc-mentions.processed.json)在**同一个状态目录**,EROFS / ENOSPC /
        // EACCES / EDQUOT 会同时命中两处写。原先 save() 裸在这里,一抛就逃出整个 for 循环:
        // 不 ack、游标不前进、批次剩下的事件也一起不处理 —— 下一 tick 原样重取,把会改文档
        // 的任务每周期重跑一遍(实测 polls=6 taskRuns=6,3.2s 内 6 遍,永不收敛),同时把
        // 卡片动作一并楔死。所以:记日志、内存游标照常前进、ack 与批次余项照常执行。
        try {
          await options.cursorStore.save(event.event_id);
        } catch (error) {
          options.log?.error?.(
            `octo: cursor save failed at event ${event.event_id} (in-memory cursor still advances): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // 内存游标无条件前进:落盘失败只影响重启后的起点,不该让本进程反复重取。
        // 重启后若因旧 cursor 再取到文档事件,持久去重表负责收敛。
        cursor = event.event_id;

        // 只 ack 自己识别并处理过的事件。未识别的只推进游标(本消费者不再重复拉取),
        // 留在服务端直至过期。
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
      }
      // Classify from forward progress, not from response size. `ordered` is what actually
      // advances the cursor (:filtered by isSafeInteger + > cursor), and every element of it is
      // assigned to `cursor` below. A response that is non-empty but entirely undrainable —
      // event ids outside the IEEE-754 safe range, or a persisted cursor ahead of what the
      // server returns after a store reset — would otherwise be classified "batch", reschedule
      // at 0ms, and re-issue the identical request forever. Reproduced at ~430 req/s before
      // this line was corrected; it falls through to "empty" and is paced by intervalMs now,
      // which is the right treatment for a server that is not making progress for us.
      outcome = ordered.length > 0 ? "batch" : "empty";
      if (events.length > 0) {
        options.log?.info?.(
          `octo: event poll batch events=${events.length} card_actions=${cardActions} doc_mentions=${docMentions} cursor=${cursor}`,
        );
      }
    } catch (error) {
      outcome = "error";
      // A stop() mid-hold aborts the request on purpose; reporting that as a poll failure would
      // put a spurious error in the log on every clean shutdown.
      if (!stopped) {
        options.log?.error?.(
          `octo: event poll failed at cursor=${cursor}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      inFlight = undefined;
      schedule(nextDelayMs(outcome, Date.now() - startedAt));
    }
  };

  const ready = options.cursorStore.load()
    .then((loaded) => {
      cursor = Number.isSafeInteger(loaded) && loaded >= 0 ? loaded : 0;
      // "bot" not "card": this loop now drains card actions *and* doc_comment_mention events.
      options.log?.info?.(`octo: bot event poller ready at cursor=${cursor}`);
      // First tick keeps main's timing: short polling waits one interval before its first read,
      // long polling starts immediately.
      schedule(waitSeconds > 0 ? 0 : intervalMs);
    })
    .catch((error) => {
      options.log?.error?.(
        `octo: event cursor load failed, starting from zero: ${error instanceof Error ? error.message : String(error)}`,
      );
      cursor = 0;
      schedule(waitSeconds > 0 ? 0 : intervalMs);
    });

  return {
    ready,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Cut a hold short rather than waiting it out. Set `stopped` first so the abort is
      // classified as a shutdown, not a poll failure.
      inFlight?.abort();
    },
    cursor(): number {
      return cursor;
    },
  };
}
