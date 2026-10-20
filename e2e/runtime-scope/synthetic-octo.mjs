// Synthetic loopback peers only. No real Octo account, token or model service.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { generateKeyPair, sharedKey } from "curve25519-js";
import CryptoJS from "crypto-js";
import { Md5 } from "md5-typescript";

export const BOT_UID = "bot_runtime_00000000000000000000000";
export const HUMAN_UID = "user_runtime_000000000000000000000";
export const REPLY = "OCTO_RUNTIME_SCOPE_OK";
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const str = (s) => { const b = Buffer.from(s); return Buffer.concat([u16(b.length), b]); };
function frame(type, body) {
  let n = body.length;
  const length = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; length.push(b); } while (n);
  return Buffer.concat([Buffer.from([type, ...length]), body]);
}

export async function createSyntheticOcto() {
  const requests = [];
  const sends = [];
  const unknown = [];
  let acked = false;
  let agentVersion;
  let finish;
  const delivered = new Promise((resolve) => { finish = resolve; });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const b of req) chunks.push(b);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : {};
    requests.push(url.pathname);
    const json = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/v1/bot/register") {
      agentVersion = body.agent_version;
      return json({ robot_id: BOT_UID, im_token: "synthetic-im-token", owner_uid: HUMAN_UID,
        ws_url: `ws://127.0.0.1:${server.address().port}/ws`, api_url: baseUrl });
    }
    if (url.pathname === "/v1/bot/groups") return json({ groups: [] });
    if (url.pathname === "/v1/bot/user/info") return json({ uid: HUMAN_UID, name: "Synthetic User" });
    if (url.pathname === "/v1/bot/card/profile") return json({ card_enabled: false,
      display_enabled: false, interaction_enabled: false, reasoning_enabled: false });
    if (url.pathname === "/v1/bot/sendMessage") {
      sends.push(body);
      json({ message_id: String(100 + sends.length), message_seq: sends.length, client_msg_no: body.client_msg_no });
      if (body.payload?.content === REPLY) finish();
      return;
    }
    if (["/v1/bot/typing", "/v1/bot/readReceipt", "/v1/bot/heartbeat"].includes(url.pathname)) return json({});
    if (url.pathname === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [{ delta: { role: "assistant", content: REPLY }, finish_reason: null },
        { delta: {}, finish_reason: "stop" }]) {
        res.write(`data: ${JSON.stringify({ id: "scope-test", object: "chat.completion.chunk",
          created: 1, model: "scripted", choices: [{ index: 0, ...choice }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    // These optional warm-ups are explicitly unsupported by this test server.
    if (["/v1/bot/mention-prefs", "/v1/bot/mention_prefs", "/v1/bot/read"].includes(url.pathname)) return json({}, 404);
    unknown.push(`${req.method} ${url.pathname}`);
    json({ error: "unsupported synthetic endpoint" }, 404);
  });
  const wsServer = new WebSocketServer({ server, path: "/ws" });
  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const bytes = Buffer.from(data);
      const type = bytes[0] >> 4;
      if (type === 7) { socket.send(Buffer.from([0x80])); return; }
      if (type === 6) { acked = true; return; }
      if (type !== 1) return;
      let offset = 1;
      while (bytes[offset++] & 128) { /* skip frame length */ }
      offset += 2; // protocol version and device flag
      const readString = () => { const n = bytes.readUInt16BE(offset); offset += 2;
        const value = bytes.subarray(offset, offset + n).toString(); offset += n; return value; };
      readString(); readString(); readString(); offset += 8;
      const clientKey = Uint8Array.from(Buffer.from(readString(), "base64"));
      const keys = generateKeyPair(Uint8Array.from(randomBytes(32)));
      const aesKey = Md5.init(Buffer.from(sharedKey(keys.private, clientKey)).toString("base64")).slice(0, 16);
      const salt = "scope-test-iv-01";
      socket.send(frame(0x21, Buffer.concat([Buffer.from([4]), u64(0), Buffer.from([1]),
        str(Buffer.from(keys.public).toString("base64")), str(salt), u64(1)])));
      // The server was created outside plugin scope. Only the client's actual
      // network async resource can propagate the managed startAccount scope.
      setTimeout(() => {
        const encrypted = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(JSON.stringify({
          type: 1, content: "Reply with the scope test marker", })), CryptoJS.enc.Utf8.parse(aesKey),
        { iv: CryptoJS.enc.Utf8.parse(salt), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString();
        socket.send(frame(0x50, Buffer.concat([Buffer.from([0]), str("test"), str(HUMAN_UID),
          str(HUMAN_UID), Buffer.from([1]), u32(0), str("scope-inbound"), u64(1), u32(1),
          u32(Math.floor(Date.now() / 1000)), Buffer.from(encrypted)])));
      }, 20);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, delivered, requests, sends, unknown,
    get acked() { return acked; }, get agentVersion() { return agentVersion; },
    async close() {
      for (const client of wsServer.clients) client.terminate();
      await new Promise((resolve) => wsServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    } };
}
