/**
 * Shared streaming helpers for media upload paths.
 *
 * Both `channel.ts#downloadToTempFile` (outbound HTTP-URL branch) and
 * `inbound.ts#uploadMedia` (inbound HTTP-URL branch) need the same
 * "stream a fetch response body to a file with a hard byte cap"
 * primitive. Centralized here so a fix to one site doesn't drift from
 * the other.
 */

import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";

/**
 * Stream a Web ReadableStream to a file path with a strict byte cap.
 *
 * - Counts every chunk from `body` toward `maxBytes`. The first chunk that
 *   pushes the running total past `maxBytes` aborts the read, cancels the
 *   upstream reader, destroys the write stream, unlinks the partial temp
 *   file, and throws `File too large (exceeds max <maxBytes> bytes)`.
 * - Honours backpressure: if `ws.write` returns false the loop awaits
 *   `drain`, racing it against any error event on the write stream so a
 *   mid-write disk-full / EIO surfaces promptly instead of hanging.
 * - On any error path (cap exceeded, write error, drain race, reader
 *   error) the upstream fetch body reader is cancelled so undici can
 *   release the socket immediately rather than at GC time.
 *
 * **Caller contract:**
 * - Caller opens the fetch and passes its `body` (a Web ReadableStream).
 *   We do NOT take a `Response` because callers may want to read other
 *   parts of it (headers etc.) before handing the body off.
 * - Caller chooses `destPath`. We open the write stream ourselves so the
 *   error/destroy/unlink lifecycle is contained in one place.
 * - On success, the temp file at `destPath` is the caller's to use; we
 *   do NOT unlink on success. Caller's `finally` block handles the
 *   eventual cleanup.
 * - On error, we unlink the partial temp file before re-throwing so the
 *   caller doesn't have to special-case partial-write cleanup.
 */
export async function streamToFileWithCap(opts: {
  body: ReadableStream<Uint8Array>;
  destPath: string;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { body, destPath, maxBytes } = opts;
  opts.signal?.throwIfAborted();
  const ws = createWriteStream(destPath);
  let totalBytes = 0;

  // Attach the error handler before the first write so a mid-stream
  // write error (disk full, EIO, etc.) is captured promptly instead of
  // crashing as an unhandled stream 'error' event. Swallow late
  // rejections — the await sites still see them via Promise.race.
  const streamError = new Promise<never>((_, reject) => {
    ws.on("error", reject);
  });
  streamError.catch(() => {});
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(opts.signal!.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), streamError, aborted]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // Fire-and-forget cancel; the surrounding catch handles the
        // remaining cleanup. .catch swallows late rejections so they
        // don't surface as unhandledRejection after we throw below.
        reader.cancel().catch(() => {});
        throw new Error(`File too large (exceeds max ${maxBytes} bytes)`);
      }
      if (!ws.write(value)) {
        await Promise.race([
          new Promise<void>(r => ws.once("drain", r)),
          streamError,
          aborted,
        ]);
      }
    }
    ws.end();
    await Promise.race([
      new Promise<void>(resolve => ws.on("finish", resolve)),
      streamError,
      aborted,
    ]);
  } catch (err) {
    // Release the upstream fetch response stream on any failure path —
    // disk-full / EIO / drain race / timeout / cap exceeded all flow
    // here. Without this, ws.write throwing leaves the body reader
    // unconsumed and undici only releases the socket on GC, leaking
    // a network connection per failed download.
    reader?.cancel().catch(() => {});
    ws.destroy();
    if (!ws.closed) await new Promise<void>(resolve => ws.once("close", resolve));
    await unlink(destPath).catch(() => {});
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
