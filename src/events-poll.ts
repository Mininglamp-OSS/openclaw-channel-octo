import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeAccountId } from "./account-id.js";
import { ackBotEvent, eventsPollTimeoutMs, fetchBotEvents } from "./api-fetch.js";
import { CHANNEL_ID } from "./constants.js";
import { parseCardAction, type CardAction } from "./card-action.js";

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
  onCardAction: (action: CardAction) => void | Promise<void>;
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
 * Start one non-overlapping poll loop, short-polling by default and long-polling when
 * `waitSeconds` is set. Cursor persistence happens before ack so a process crash can at worst
 * replay an action; it cannot acknowledge an event that it forgot locally.
 */
export function startEventPoller(options: EventPollerOptions): EventPoller {
  const intervalMs = Math.max(500, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const waitSeconds =
    options.waitSeconds && options.waitSeconds > 0 ? Math.floor(options.waitSeconds) : 0;
  let cursor = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Tracks the in-flight request so stop() can cut a hold short. Without this the loop is a
  // single sequential chain, so a stop during a 25s hold would keep the account busy for the
  // rest of that hold instead of shutting down.
  let inFlight: AbortController | undefined;

  const schedule = (): void => {
    if (stopped) return;
    // When long-polling, the server already paces the loop: it holds an empty queue and answers
    // early only when there is something to deliver. Sleeping another intervalMs on top would
    // reintroduce exactly the latency the hold removes.
    timer = setTimeout(() => void tick(), waitSeconds > 0 ? 0 : intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
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
      const ordered = events
        .filter((event) => Number.isSafeInteger(event.event_id) && event.event_id > cursor)
        .sort((a, b) => a.event_id - b.event_id);
      for (const event of ordered) {
        const action = parseCardAction(event);
        if (action) {
          cardActions += 1;
          await options.onCardAction(action);
        }

        await options.cursorStore.save(event.event_id);
        cursor = event.event_id;

        if (action && options.ack !== false) {
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
      if (events.length > 0) {
        options.log?.info?.(
          `octo: event poll batch events=${events.length} card_actions=${cardActions} cursor=${cursor}`,
        );
      }
    } catch (error) {
      // A stop() mid-hold aborts the request on purpose; reporting that as a poll failure would
      // put a spurious error in the log on every clean shutdown.
      if (!stopped) {
        options.log?.error?.(
          `octo: event poll failed at cursor=${cursor}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      inFlight = undefined;
      schedule();
    }
  };

  const ready = options.cursorStore.load()
    .then((loaded) => {
      cursor = Number.isSafeInteger(loaded) && loaded >= 0 ? loaded : 0;
      options.log?.info?.(`octo: card event poller ready at cursor=${cursor}`);
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
      // Cut a hold short rather than waiting it out. Set `stopped` first so the abort is
      // classified as a shutdown, not a poll failure.
      inFlight?.abort();
    },
    cursor(): number {
      return cursor;
    },
  };
}
