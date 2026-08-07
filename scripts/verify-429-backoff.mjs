// Measures what the backoff actually waits, over a real socket.
//
// The headers and body replayed here are the ones captured from a live octo-server by
// verify-429.mjs — that script proves the parser reads a real response correctly. Forcing a
// real server to answer 429 for one specific request needs its limit turned down to ~1 rps,
// which on this box would mean a second server sharing the running environment's MySQL schema
// and Redis rate-limit keyspace. Not worth disturbing a live environment to measure a sleep.
//
// Run: node scripts/verify-429-backoff.mjs
import { createServer } from "node:http";
import { postJson, MAX_429_RETRIES } from "../dist/src/api-fetch.js";
import { OctoApiError } from "../dist/src/api-error.js";

/** Verbatim from a live octo-server (octo-lib rate limiter, per-IP bucket). */
const REAL_BODY = JSON.stringify({
  error: {
    code: "err.shared.rate.limited",
    details: { retry_after: 1 },
    http_status: 429,
    message: "请求过于频繁，请稍后再试。",
  },
  msg: "请求过于频繁，请稍后再试。",
  status: 429,
});
const REAL_HEADERS = {
  "retry-after": "1",
  "x-ratelimit-limit": "1000",
  "x-ratelimit-remaining": "0",
  "x-ratelimit-scope": "ip",
  "content-type": "application/json; charset=utf-8",
};

let limitedResponses = 0;
let succeedAfter = Number.POSITIVE_INFINITY;
const attemptAt = [];

const server = createServer((req, res) => {
  attemptAt.push(Date.now());
  if (attemptAt.length > succeedAfter) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  limitedResponses++;
  res.writeHead(429, REAL_HEADERS);
  res.end(REAL_BODY);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

function gaps() {
  return attemptAt.slice(1).map((t, i) => t - attemptAt[i]);
}

console.log("--- case 1: limited on every attempt ---");
attemptAt.length = 0;
let err;
const t0 = Date.now();
try {
  await postJson(apiUrl, "tok", "/v1/bot/sendMessage", {});
} catch (e) {
  err = e;
}
const elapsed1 = Date.now() - t0;
const gaps1 = gaps();
console.log(`attempts=${attemptAt.length} elapsed=${elapsed1}ms gaps=${JSON.stringify(gaps1)}`);
console.log(`threw=${err?.constructor?.name} status=${err?.status} retryAfterMs=${err?.retryAfterMs}`);

console.log("\n--- case 2: second attempt succeeds ---");
attemptAt.length = 0;
succeedAfter = 1;
const t1 = Date.now();
const ok = await postJson(apiUrl, "tok", "/v1/bot/sendMessage", {});
const elapsed2 = Date.now() - t1;
const gaps2 = gaps();
console.log(`attempts=${attemptAt.length} elapsed=${elapsed2}ms gaps=${JSON.stringify(gaps2)} result=${JSON.stringify(ok)}`);

console.log("\n--- case 3: a caller that opts out ---");
attemptAt.length = 0;
succeedAfter = Number.POSITIVE_INFINITY;
let optOutErr;
try {
  await postJson(apiUrl, "tok", "/v1/bot/heartbeat", {}, undefined, { retryOn429: false });
} catch (e) {
  optOutErr = e;
}
console.log(`attempts=${attemptAt.length} threw=${optOutErr?.constructor?.name} status=${optOutErr?.status}`);

server.close();

const checks = [
  ["gives up as a structured 429", err instanceof OctoApiError && err.status === 429],
  ["reads the server's 1s wait off the real headers", err?.retryAfterMs === 1000],
  [`makes exactly ${MAX_429_RETRIES + 1} attempts`, gaps1.length === MAX_429_RETRIES],
  ["never retries earlier than the server asked", gaps1.every((g) => g >= 1000)],
  ["never waits more than the jitter allows", gaps1.every((g) => g <= 1250 + 250)],
  ["a retry that succeeds returns the retry's body", ok !== undefined],
  ["the successful run waited too", gaps2.every((g) => g >= 1000)],
  ["an opted-out caller sends exactly once", attemptAt.length === 1],
  ["and still gets the structured error", optOutErr instanceof OctoApiError && optOutErr.status === 429],
];

console.log("\n=== assertions ===");
let bad = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) bad++;
}
console.log(`\n429 responses served: ${limitedResponses}`);
process.exit(bad === 0 ? 0 : 1);
