// Real-environment check for the 429 path: flood a live octo-server until its rate limiter
// answers, then feed that actual response into the parser this change set added.
//
// Run: node scripts/verify-429.mjs [url]
import { OctoApiError } from "../dist/src/api-error.js";

const url = process.argv[2] ?? "http://127.0.0.1:8090/v1/users/me";
const CONCURRENCY = 400;
const ROUNDS = 30;

let firstLimited = null;
const codes = new Map();
let sent = 0;

async function one() {
  try {
    const resp = await fetch(url, { method: "GET" });
    sent++;
    codes.set(resp.status, (codes.get(resp.status) ?? 0) + 1);
    if (resp.status === 429 && !firstLimited) {
      firstLimited = {
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries([...resp.headers.entries()]),
        body: await resp.text(),
      };
    }
  } catch (err) {
    codes.set(String(err.code ?? err.name), (codes.get(String(err.code ?? err.name)) ?? 0) + 1);
  }
}

for (let r = 0; r < ROUNDS && !firstLimited; r++) {
  await Promise.all(Array.from({ length: CONCURRENCY }, one));
}

console.log(`sent=${sent}`);
console.log("codes:", Object.fromEntries(codes));

if (!firstLimited) {
  console.log("\nNO 429 — bucket never drained; raise CONCURRENCY/ROUNDS or lower the server limit.");
  process.exit(2);
}

console.log("\n=== real 429 response ===");
console.log("statusText:", JSON.stringify(firstLimited.statusText));
for (const [k, v] of Object.entries(firstLimited.headers)) {
  if (/ratelimit|retry/i.test(k)) console.log(`  ${k}: ${v}`);
}
console.log("body:", firstLimited.body);

console.log("\n=== what OctoApiError.from makes of it ===");
const err = OctoApiError.from(
  {
    status: firstLimited.status,
    statusText: firstLimited.statusText,
    headers: { get: (n) => firstLimited.headers[n.toLowerCase()] ?? null },
  },
  "/v1/bot/heartbeat",
  firstLimited.body,
);
console.log("  isRateLimited     :", err.isRateLimited);
console.log("  status            :", err.status);
console.log("  retryAfterMs      :", err.retryAfterMs);
console.log("  rateLimitScope    :", JSON.stringify(err.rateLimitScope));
console.log("  rateLimitRemaining:", JSON.stringify(err.rateLimitRemaining));
console.log("  message           :", err.message);

const checks = [
  ["isRateLimited is true", err.isRateLimited === true],
  ["retryAfterMs is a positive number", Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0],
  ["scope came through", typeof err.rateLimitScope === "string" && err.rateLimitScope.length > 0],
  ["remaining came through", typeof err.rateLimitRemaining === "string"],
  ["message keeps the failed (NNN) shape", /failed \(429\)/.test(err.message)],
];
console.log("\n=== assertions ===");
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) bad++;
}
process.exit(bad === 0 ? 0 : 1);
