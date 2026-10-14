import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { uploadAndSendMedia } from "./inbound.js";
import { streamToFileWithCap } from "./stream-helpers.js";
import { ChannelType } from "./types.js";

describe("media upload cancellation", () => {
  it.each(["download headers", "download body", "presign", "PUT"])("aborts during %s without sending or leaving a temp file", async stage => {
    const filename = `cancel-${randomUUID()}.txt`;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let baseUrl = "";
    const sends: string[] = [];
    const server = createServer((req, res) => {
      if (req.url === `/${filename}`) {
        if (stage === "download headers") { enter(); return; }
        res.writeHead(200, { "content-type": "text/plain" });
        if (stage === "download body") { res.write("partial"); enter(); return; }
        res.end("media");
      } else if (req.url?.startsWith("/v1/bot/upload/presigned")) {
        if (stage === "presign") { enter(); return; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ uploadUrl: `${baseUrl}/put`, downloadUrl: `${baseUrl}/file`, contentType: "text/plain" }));
      } else if (req.url === "/put") {
        req.resume();
        if (stage === "PUT") { enter(); return; }
        res.end();
      } else {
        sends.push(req.url ?? "");
        res.end("{}");
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const controller = new AbortController();
    const reason = new Error(`cancel during ${stage}`);
    const settled = uploadAndSendMedia({
      mediaUrl: `${baseUrl}/${filename}`, apiUrl: baseUrl, botToken: "local-test",
      channelId: "user", channelType: ChannelType.DM, signal: controller.signal,
    }).then(() => "sent", error => error);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered;
      controller.abort(reason);
      const outcome = await Promise.race([
        settled,
        new Promise(resolve => { deadline = setTimeout(() => resolve("still pending after abort"), 500); }),
      ]);
      expect(outcome).toBe(reason);
      expect(sends).toEqual([]);
      expect((await readdir("/tmp/octo-upload")).filter(name => name.endsWith(filename))).toEqual([]);
    } finally {
      if (deadline) clearTimeout(deadline);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await settled;
    }
  });

  it("cancels a stalled response-body reader and removes the partial file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "octo-stream-abort-"));
    const destPath = join(dir, "partial.txt");
    const cancel = vi.fn();
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let pulls = 0;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array([1]));
        else enter();
      }, cancel,
    });
    const controller = new AbortController();
    const reason = new Error("cancel response body");
    const settled = streamToFileWithCap({ body, destPath, maxBytes: 100, signal: controller.signal })
      .then(() => "finished", error => error);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered;
      controller.abort(reason);
      expect(await Promise.race([
        settled,
        new Promise(resolve => { deadline = setTimeout(() => resolve("still pending after abort"), 500); }),
      ])).toBe(reason);
      expect(cancel).toHaveBeenCalled();
      await expect(stat(destPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (deadline) clearTimeout(deadline);
      // Also unblock the original implementation when this test is run red-first.
      try { source.error(reason); } catch { /* already cancelled */ }
      await settled;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
