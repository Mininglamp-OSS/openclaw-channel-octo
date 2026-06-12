import { describe, it, expect, vi } from "vitest";

/**
 * Unit tests for the deliver buffer pattern used in handleInboundMessage.
 *
 * The deliver callback uses info.kind to decide behavior:
 * - "tool"  → send immediately via resolveAndSendText (verbose output)
 * - "final" (normal) → send immediately, mark userFacingFinalDelivered
 * - "final" (tool warning) → defer to pendingToolWarningFinal
 * - "block" / other → buffer text (overwrite), send once in finally
 *
 * - isReasoning payloads are skipped entirely
 * - Media payloads are always sent immediately with dedup
 * - The finally block sends the last buffered text after dispatcher finishes
 * - onError clears the buffer to prevent stale text
 * - onFreshSettledDelivery sends pending tool warning as fallback
 */

// ---- helpers that mirror the production logic in inbound.ts ----

// Bounded signal used by the production sends (DISPATCH_TIMEOUT_APOLOGY_MS).
// Mirror sends pass AbortSignal.timeout(...) so a sick Octo API can't strand
// the per-group queue; tests assert the signal is forwarded.
const DISPATCH_TIMEOUT_APOLOGY_MS = 10_000;

function createDeliverBuffer() {
  return {
    lastText: null as string | null,
    textSent: false,
  };
}

interface DeliverState {
  userFacingFinalDelivered: boolean;
  pendingToolWarningFinal: { text: string } | undefined;
  deliveryErrorOccurred: boolean;
  replySucceeded: boolean;
}

function createDeliverState(): DeliverState {
  return {
    userFacingFinalDelivered: false,
    pendingToolWarningFinal: undefined,
    deliveryErrorOccurred: false,
    replySucceeded: false,
  };
}

function makeDeliver(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  state: DeliverState,
  sentMediaUrls: Set<string>,
  sendMediaFn: (url: string) => Promise<void>,
  sendTextFn: (text: string, signal?: AbortSignal) => Promise<void>,
  isToolWarningFn: (payload: any) => boolean,
) {
  return async (
    payload: {
      text?: string;
      mediaUrls?: string[];
      mediaUrl?: string;
      isReasoning?: boolean;
      isError?: boolean;
    },
    info: { kind: string },
  ) => {
    // Skip reasoning blocks
    if (payload.isReasoning) return;

    const kind = info.kind;

    // Media: send immediately with dedup
    const outboundMediaUrls = [
      ...(payload.mediaUrls ?? []),
      ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ].filter(Boolean);

    for (const url of outboundMediaUrls) {
      if (sentMediaUrls.has(url)) continue;
      try {
        await sendMediaFn(url);
        sentMediaUrls.add(url);
      } catch {
        // Failed media is NOT added to sentMediaUrls — can be retried
      }
    }

    // Text handling based on kind
    const content = payload.text?.trim() ?? "";
    if (!content && sentMediaUrls.size > 0) {
      state.replySucceeded = true;
      return;
    }
    if (!content) return;

    if (kind === "tool") {
      // Verbose tool call output: send immediately
      await sendTextFn(content, AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS));
      state.replySucceeded = true;
      return;
    }

    if (kind === "final") {
      if (isToolWarningFn(payload)) {
        if (!state.userFacingFinalDelivered) {
          state.pendingToolWarningFinal = { text: content };
        }
        return;
      }

      await sendTextFn(content, AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS));
      state.replySucceeded = true;
      state.userFacingFinalDelivered = true;
      state.pendingToolWarningFinal = undefined;
      deliverBuffer.lastText = null;
      deliverBuffer.textSent = true;
      return;
    }

    // kind === "block" / anything else: buffer, send once after dispatcher finishes
    deliverBuffer.lastText = content;
  };
}

function makeOnError(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  state: DeliverState,
  sendErrorFn: () => Promise<void>,
) {
  return async (_err: unknown) => {
    deliverBuffer.lastText = null;
    deliverBuffer.textSent = true;
    state.deliveryErrorOccurred = true;
    await sendErrorFn();
  };
}

function makeOnFreshSettledDelivery(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  state: DeliverState,
  sendTextFn: (text: string, signal?: AbortSignal) => Promise<void>,
) {
  return async () => {
    if (!state.pendingToolWarningFinal || state.userFacingFinalDelivered || state.deliveryErrorOccurred) {
      return undefined;
    }
    // Buffered block text is the real user-facing reply; let the finally
    // flush deliver it and drop the warning fallback (single message).
    if (deliverBuffer.lastText && !deliverBuffer.textSent) {
      state.pendingToolWarningFinal = undefined;
      return undefined;
    }
    const pending = state.pendingToolWarningFinal;
    state.pendingToolWarningFinal = undefined;
    try {
      await sendTextFn(pending.text, AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS));
      state.replySucceeded = true;
      return { visibleReplySent: true };
    } catch {
      return { visibleReplySent: false };
    }
  };
}

async function runFinally(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  sendTextFn: (text: string, signal?: AbortSignal) => Promise<void>,
  state?: DeliverState,
) {
  if (deliverBuffer.lastText && !deliverBuffer.textSent) {
    deliverBuffer.textSent = true;
    await sendTextFn(deliverBuffer.lastText, AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS));
    if (state) state.replySucceeded = true;
  }
}

// Standard non-warning payload
function textPayload(text: string) {
  return { text };
}

// Tool warning payload (isError=true, simulates nonTerminalToolErrorWarning)
function toolWarningPayload(text: string) {
  return { text, isError: true as const };
}

// Default isToolWarning checker: treats any payload with isError=true as a tool warning
const defaultIsToolWarning = (payload: any) => payload.isError === true;

// ---- tests ----

describe("deliver buffer pattern", () => {
  it("block kind: buffers text without sending", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);

    await deliver({ text: "Hello" }, { kind: "block" });
    await deliver({ text: "Hello, how are you" }, { kind: "block" });
    await deliver({ text: "Hello, how are you? I'm here to help." }, { kind: "block" });

    // Text should NOT have been sent
    expect(sendText).not.toHaveBeenCalled();
    // Buffer should have the latest text
    expect(deliverBuffer.lastText).toBe("Hello, how are you? I'm here to help.");
    expect(deliverBuffer.textSent).toBe(false);

    // finally block sends the buffered text
    await runFinally(deliverBuffer, sendText, state);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Hello, how are you? I'm here to help.", expect.any(AbortSignal));
    expect(deliverBuffer.textSent).toBe(true);
  });

  it("final kind: sends text immediately", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);

    await deliver(textPayload("Final answer"), { kind: "final" });

    // final is sent immediately
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Final answer", expect.any(AbortSignal));
    expect(state.userFacingFinalDelivered).toBe(true);
    // Buffer is cleared to prevent finally from re-sending
    expect(deliverBuffer.textSent).toBe(true);
    expect(deliverBuffer.lastText).toBeNull();

    // finally block should NOT send again
    await runFinally(deliverBuffer, sendText, state);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("tool kind: sends text immediately, does not affect buffer", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);

    await deliver({ text: "Tool output: file listing..." }, { kind: "tool" });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Tool output: file listing...", expect.any(AbortSignal));
    // tool does NOT set textSent — final text should still be sent via finally
    expect(deliverBuffer.textSent).toBe(false);
    expect(deliverBuffer.lastText).toBeNull();
  });

  it("tool then final: tool sent immediately, final sent immediately", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);

    // Tool output sent immediately
    await deliver({ text: "exec: ls" }, { kind: "tool" });
    expect(sendText).toHaveBeenCalledTimes(1);

    // Block buffered
    await deliver({ text: "Checking files..." }, { kind: "block" });
    expect(sendText).toHaveBeenCalledTimes(1);

    // Final sent immediately
    await deliver(textPayload("Here are your files: ..."), { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenLastCalledWith("Here are your files: ...", expect.any(AbortSignal));

    // finally should not send again
    await runFinally(deliverBuffer, sendText, state);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("isReasoning: skips entirely", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);

    await deliver({ text: "Internal reasoning...", isReasoning: true }, { kind: "block" });
    await deliver({ text: "More reasoning", isReasoning: true }, { kind: "final" });

    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.lastText).toBeNull();

    await runFinally(deliverBuffer, sendText, state);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("blocks then final: blocks buffered, final sent immediately", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);

    // Streaming blocks
    await deliver({ text: "Part 1" }, { kind: "block" });
    await deliver({ text: "Part 1 Part 2" }, { kind: "block" });
    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.lastText).toBe("Part 1 Part 2");

    // Final arrives — sent immediately, clears buffer
    await deliver(textPayload("Complete response"), { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Complete response", expect.any(AbortSignal));
    expect(deliverBuffer.lastText).toBeNull();

    // finally block should not send again
    await runFinally(deliverBuffer, sendText, state);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("onError clears buffer so finally does not send stale text", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendError = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onError = makeOnError(deliverBuffer, state, sendError);

    // Partial text buffered before error
    await deliver({ text: "Partial response from AI..." }, { kind: "block" });
    expect(deliverBuffer.lastText).toBe("Partial response from AI...");

    // onError fires
    await onError(new Error("AI generation failed"));

    expect(deliverBuffer.lastText).toBeNull();
    expect(deliverBuffer.textSent).toBe(true);
    expect(state.deliveryErrorOccurred).toBe(true);
    expect(sendError).toHaveBeenCalledTimes(1);

    // finally block — should NOT send anything
    await runFinally(deliverBuffer, sendText, state);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("media is sent immediately via deliver, not buffered", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);

    await deliver({ mediaUrl: "https://example.com/img1.png" }, { kind: "final" });
    await deliver({
      mediaUrls: [
        "https://example.com/img2.png",
        "https://example.com/img3.png",
      ],
    }, { kind: "tool" });

    // Media sent immediately — three calls total
    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(sendMedia).toHaveBeenCalledWith("https://example.com/img1.png");
    expect(sendMedia).toHaveBeenCalledWith("https://example.com/img2.png");
    expect(sendMedia).toHaveBeenCalledWith("https://example.com/img3.png");

    // No text was buffered
    expect(deliverBuffer.lastText).toBeNull();

    // finally should not send text
    await runFinally(deliverBuffer, sendText, state);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sentMediaUrls dedup: same URL is not sent twice", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);

    await deliver({ mediaUrl: "https://example.com/img.png" }, { kind: "block" });
    await deliver({ mediaUrl: "https://example.com/img.png" }, { kind: "final" });

    // Only one call — second was deduped
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sentMediaUrls.size).toBe(1);
  });
});

describe("tool warning deferral", () => {
  it("normal final first + warning final second: normal sent, warning discarded", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onSettled = makeOnFreshSettledDelivery(deliverBuffer, state, sendText);

    // Normal final sent immediately
    await deliver(textPayload("Here is your answer with 173 chars of content..."), { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Here is your answer with 173 chars of content...", expect.any(AbortSignal));
    expect(state.userFacingFinalDelivered).toBe(true);

    // Tool warning final arrives — discarded (userFacingFinalDelivered=true, not stored)
    await deliver(toolWarningPayload("write_file failed"), { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(state.pendingToolWarningFinal).toBeUndefined();

    // onFreshSettledDelivery: skips (userFacingFinalDelivered=true)
    const result = await onSettled();
    expect(result).toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("warning final first + normal final second: warning deferred then cleared", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onSettled = makeOnFreshSettledDelivery(deliverBuffer, state, sendText);

    // Tool warning arrives first — deferred
    await deliver(toolWarningPayload("write_file failed"), { kind: "final" });
    expect(sendText).not.toHaveBeenCalled();
    expect(state.pendingToolWarningFinal).toEqual({ text: "write_file failed" });

    // Normal final arrives — sent immediately, clears pending warning
    await deliver(textPayload("Here is your answer"), { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Here is your answer", expect.any(AbortSignal));
    expect(state.userFacingFinalDelivered).toBe(true);
    expect(state.pendingToolWarningFinal).toBeUndefined();

    // onFreshSettledDelivery: skips (warning already cleared)
    const result = await onSettled();
    expect(result).toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("only warning final, no normal final: warning sent as fallback via onFreshSettledDelivery", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onSettled = makeOnFreshSettledDelivery(deliverBuffer, state, sendText);

    // Only tool warning final — deferred
    await deliver(toolWarningPayload("write_file failed"), { kind: "final" });
    expect(sendText).not.toHaveBeenCalled();
    expect(state.pendingToolWarningFinal).toEqual({ text: "write_file failed" });
    expect(state.userFacingFinalDelivered).toBe(false);

    // onFreshSettledDelivery: sends the warning as fallback
    const result = await onSettled();
    expect(result).toEqual({ visibleReplySent: true });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("write_file failed", expect.any(AbortSignal));
    expect(state.pendingToolWarningFinal).toBeUndefined();
  });

  it("only normal final, no warning: normal sent immediately, onFreshSettledDelivery skips", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onSettled = makeOnFreshSettledDelivery(deliverBuffer, state, sendText);

    // Normal final — sent immediately
    await deliver(textPayload("Complete answer"), { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(state.userFacingFinalDelivered).toBe(true);

    // onFreshSettledDelivery: skips (no pending warning)
    const result = await onSettled();
    expect(result).toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("tool text or media success does not affect warning fallback judgment", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onSettled = makeOnFreshSettledDelivery(deliverBuffer, state, sendText);

    // Tool text sent immediately — replySucceeded=true
    await deliver({ text: "Tool: ls output" }, { kind: "tool" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(state.replySucceeded).toBe(true);

    // Media sent immediately — replySucceeded stays true
    await deliver({ mediaUrl: "https://example.com/img.png" }, { kind: "final" });
    expect(sendMedia).toHaveBeenCalledTimes(1);

    // Warning final arrives — deferred (userFacingFinalDelivered is still false)
    await deliver(toolWarningPayload("write_file failed"), { kind: "final" });
    expect(state.userFacingFinalDelivered).toBe(false);
    expect(state.pendingToolWarningFinal).toEqual({ text: "write_file failed" });

    // onFreshSettledDelivery: sends warning (replySucceeded is irrelevant)
    const result = await onSettled();
    expect(result).toEqual({ visibleReplySent: true });
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenLastCalledWith("write_file failed", expect.any(AbortSignal));
  });

  it("onError prevents warning fallback delivery", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendError = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onError = makeOnError(deliverBuffer, state, sendError);
    const onSettled = makeOnFreshSettledDelivery(deliverBuffer, state, sendText);

    // Warning deferred
    await deliver(toolWarningPayload("write_file failed"), { kind: "final" });
    expect(state.pendingToolWarningFinal).toEqual({ text: "write_file failed" });

    // Error occurs — deliveryErrorOccurred=true
    await onError(new Error("dispatch failed"));
    expect(state.deliveryErrorOccurred).toBe(true);
    expect(sendError).toHaveBeenCalledTimes(1);

    // onFreshSettledDelivery: skips (deliveryErrorOccurred guard)
    const result = await onSettled();
    expect(result).toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("bounded immediate-final send: normal final and fallback send pass an AbortSignal", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onSettled = makeOnFreshSettledDelivery(deliverBuffer, state, sendText);

    // Normal final immediate send — must be bounded by a signal so a hung
    // Octo sendMessage can't stall the per-group queue for the full dispatch
    // timeout.
    await deliver(textPayload("Final answer"), { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(1);
    const [, finalSignal] = sendText.mock.calls[0];
    expect(finalSignal).toBeInstanceOf(AbortSignal);

    // Fresh state: only a tool warning, delivered via onFreshSettledDelivery
    // fallback — that send must also be bounded.
    const deliverBuffer2 = createDeliverBuffer();
    const state2 = createDeliverState();
    const sendText2 = vi.fn().mockResolvedValue(undefined);
    const deliver2 = makeDeliver(deliverBuffer2, state2, new Set<string>(), sendMedia, sendText2, defaultIsToolWarning);
    const onSettled2 = makeOnFreshSettledDelivery(deliverBuffer2, state2, sendText2);

    await deliver2(toolWarningPayload("write_file failed"), { kind: "final" });
    expect(sendText2).not.toHaveBeenCalled();

    await onSettled2();
    expect(sendText2).toHaveBeenCalledTimes(1);
    const [, fallbackSignal] = sendText2.mock.calls[0];
    expect(fallbackSignal).toBeInstanceOf(AbortSignal);
  });

  it("block then warning-only final → single send: block delivered, warning dropped", async () => {
    const deliverBuffer = createDeliverBuffer();
    const state = createDeliverState();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, state, sentMediaUrls, sendMedia, sendText, defaultIsToolWarning);
    const onSettled = makeOnFreshSettledDelivery(deliverBuffer, state, sendText);

    // Block buffers the real user-facing reply
    await deliver({ text: "Here is the buffered block reply" }, { kind: "block" });
    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.lastText).toBe("Here is the buffered block reply");

    // Fallback-only tool-warning final — deferred
    await deliver(toolWarningPayload("write_file failed"), { kind: "final" });
    expect(state.pendingToolWarningFinal).toEqual({ text: "write_file failed" });

    // onFreshSettledDelivery: buffered block is pending → drop the warning,
    // do NOT send it, and clear pendingToolWarningFinal
    const result = await onSettled();
    expect(result).toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
    expect(state.pendingToolWarningFinal).toBeUndefined();

    // finally flush delivers the block text — exactly one message overall
    await runFinally(deliverBuffer, sendText, state);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Here is the buffered block reply", expect.any(AbortSignal));
  });
});
