import { describe, expect, it } from "vitest";

import { DEFAULT_RETRY_AFTER_MS, MAX_ERROR_BODY_CHARS, OctoApiError } from "./api-error.js";
import { httpStatusFromApiFetchError } from "./api-fetch.js";

/** Minimal `Response`-shaped stub; header lookup is case-insensitive like the real one. */
const resp = (status: number, headers: Record<string, string> = {}) => ({
  status,
  statusText: "err",
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
});

describe("OctoApiError.from", () => {
  it("prefers the Retry-After header over the body hint", () => {
    const err = OctoApiError.from(
      resp(429, { "retry-after": "3" }),
      "/v1/bot/heartbeat",
      JSON.stringify({ error: { details: { retry_after: 9 } } }),
    );
    expect(err.retryAfterMs).toBe(3_000);
  });

  it("falls back to the body hint when the header is absent", () => {
    const err = OctoApiError.from(
      resp(429),
      "/v1/bot/heartbeat",
      JSON.stringify({ error: { details: { retry_after: 2 } } }),
    );
    expect(err.retryAfterMs).toBe(2_000);
  });

  it("defaults when neither carries a hint", () => {
    expect(OctoApiError.from(resp(429), "/v1/bot/heartbeat", "").retryAfterMs).toBe(
      DEFAULT_RETRY_AFTER_MS,
    );
  });

  // Shortening the server's wait is the same mistake as not waiting at all: it puts us
  // back before it said we could. Whether such a wait is worth honouring is the
  // retry policy's call, so the parse must not pre-empt it by clamping.
  it("keeps a large but legal Retry-After verbatim", () => {
    expect(OctoApiError.from(resp(429, { "retry-after": "300" }), "/p", "").retryAfterMs).toBe(
      300_000,
    );
  });

  // Zero deserves its own line: it is finite and non-negative, so a naive guard lets it
  // through, and postJson would then retry three times with no wait at all — piling on at
  // the exact moment the server said stop.
  it("treats a zero wait as no usable hint", () => {
    expect(OctoApiError.from(resp(429, { "retry-after": "0" }), "/p", "").retryAfterMs).toBe(
      DEFAULT_RETRY_AFTER_MS,
    );
  });

  it("treats a zero body hint the same way", () => {
    const err = OctoApiError.from(
      resp(429),
      "/p",
      JSON.stringify({ error: { details: { retry_after: 0 } } }),
    );
    expect(err.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });

  it.each(["abc", "-5", "Wed, 21 Oct 2026 07:28:00 GMT", ""])(
    "falls back to the default for the unusable Retry-After %j",
    (raw) => {
      expect(OctoApiError.from(resp(429, { "retry-after": raw }), "/p", "").retryAfterMs).toBe(
        DEFAULT_RETRY_AFTER_MS,
      );
    },
  );

  it("ignores a non-numeric body hint", () => {
    const err = OctoApiError.from(
      resp(429),
      "/p",
      JSON.stringify({ error: { details: { retry_after: "soon" } } }),
    );
    expect(err.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });

  it("survives a body that is not JSON", () => {
    const err = OctoApiError.from(resp(429), "/p", "<html>502 Bad Gateway</html>");
    expect(err.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });

  it("carries the rate-limit diagnostics", () => {
    const err = OctoApiError.from(
      resp(429, { "x-ratelimit-scope": "ip", "x-ratelimit-remaining": "0" }),
      "/p",
      "",
    );
    expect(err.rateLimitScope).toBe("ip");
    expect(err.rateLimitRemaining).toBe("0");
    expect(err.isRateLimited).toBe(true);
  });

  it("is not rate limited for other statuses", () => {
    expect(OctoApiError.from(resp(500), "/p", "").isRateLimited).toBe(false);
  });

  // A hand-rolled response object may carry no headers at all. Reading them must never
  // turn a plain HTTP failure into a TypeError.
  it("tolerates a response without headers", () => {
    const err = OctoApiError.from({ status: 429, statusText: "err" }, "/p", "");
    expect(err.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(err.rateLimitScope).toBeUndefined();
  });

  it("falls back to statusText when the body is empty", () => {
    expect(OctoApiError.from(resp(503), "/p", "").body).toBe("err");
  });

  // The body reaches both the message and the logs; a gateway returning a full HTML
  // error page would otherwise put tens of KB on one line.
  it("truncates an oversized body", () => {
    const err = OctoApiError.from(resp(500), "/p", "x".repeat(MAX_ERROR_BODY_CHARS + 50));
    expect(err.body).toHaveLength(MAX_ERROR_BODY_CHARS + 1); // + the ellipsis
    expect(err.body.endsWith("…")).toBe(true);
  });

  // Truncation is cosmetic and must not cost us the retry hint.
  it("still finds a retry hint sitting past the truncation point", () => {
    const padding = "x".repeat(MAX_ERROR_BODY_CHARS);
    const body = JSON.stringify({ pad: padding, error: { details: { retry_after: 4 } } });
    const err = OctoApiError.from(resp(429), "/p", body);
    expect(err.retryAfterMs).toBe(4_000);
    expect(err.body.length).toBeLessThanOrEqual(MAX_ERROR_BODY_CHARS + 1);
  });

  // An existing regex parser reads the status back out of this exact wording, and
  // card-progress classifies failures through it.
  it("keeps the message format the existing status parser expects", () => {
    const err = OctoApiError.from(resp(429), "/v1/bot/heartbeat", "nope");
    expect(err.message).toBe("Octo API /v1/bot/heartbeat failed (429): nope");
  });

  it("is an Error named OctoApiError", () => {
    const err = OctoApiError.from(resp(429), "/p", "");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OctoApiError");
    expect(err.path).toBe("/p");
    expect(err.status).toBe(429);
  });
});

describe("httpStatusFromApiFetchError", () => {
  it("reads the status off an OctoApiError field", () => {
    expect(httpStatusFromApiFetchError(OctoApiError.from(resp(503), "/p", ""))).toBe(503);
  });

  it("still parses the legacy message format", () => {
    expect(httpStatusFromApiFetchError(new Error("Octo API /p failed (404): x"))).toBe(404);
  });

  it("returns undefined when there is no status to find", () => {
    expect(httpStatusFromApiFetchError(new Error("network down"))).toBeUndefined();
  });

  it("agrees with the regex for an OctoApiError", () => {
    const err = OctoApiError.from(resp(429), "/v1/bot/sendMessage", "limited");
    expect(httpStatusFromApiFetchError(err)).toBe(429);
    expect(err.message).toMatch(/failed \(429\)/);
  });
});
