// Test-only WuKongIM peer. Delivers through the production socket/queue, never
// imports Octo runtime or inbound. Dependencies are declared by the companion.
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { generateKeyPair, sharedKey } from "curve25519-js";
import CryptoJS from "crypto-js";
import { Md5 } from "md5-typescript";
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
export function createSocketPeer(server, expectedPath) {
  const ws = new WebSocketServer({ server });
  const peers = new Map();
  let sequence = 0;
  ws.on("connection", (socket, request) => {
    if (expectedPath && new URL(request.url, "http://localhost").pathname !== expectedPath) { socket.close(1008, "wrong run"); return; }
    let peer;
    socket.on("message", (data) => {
      const bytes = Buffer.from(data);
      const type = bytes[0] >> 4;
      if (type === 7) { socket.send(Buffer.from([0x80])); return; }
      let offset = 1;
      while (bytes[offset++] & 128) { /* frame length */ }
      if (type === 6) {
        const id = bytes.readBigUInt64BE(offset).toString();
        const pending = peer?.pending.get(id);
        if (pending && bytes.readUInt32BE(offset + 8) === pending.seq) {
          clearTimeout(pending.timer); peer.pending.delete(id); pending.resolve({ messageId: id, messageSeq: pending.seq });
        }
        return;
      }
      if (type !== 1) return;
      offset += 2;
      const readString = () => { const n = bytes.readUInt16BE(offset); offset += 2;
        const value = bytes.subarray(offset, offset + n).toString(); offset += n; return value; };
      readString(); const uid = readString(); readString(); offset += 8;
      const clientKey = Uint8Array.from(Buffer.from(readString(), "base64"));
      const keys = generateKeyPair(Uint8Array.from(randomBytes(32)));
      const aesKey = Md5.init(Buffer.from(sharedKey(keys.private, clientKey)).toString("base64")).slice(0, 16);
      const account = new URL(request.url, "http://localhost").searchParams.get("account") ?? uid;
      peer = { socket, aesKey, salt: "card-e2e-iv-00001", pending: new Map() };
      peers.set(account, peer);
      socket.send(frame(0x21, Buffer.concat([Buffer.from([4]), u64(0), Buffer.from([1]),
        str(Buffer.from(keys.public).toString("base64")), str(peer.salt), u64(1)])));
      socket.on("close", () => {
        if (peers.get(account) === peer) peers.delete(account);
        for (const p of peer.pending.values()) { clearTimeout(p.timer); p.reject(new Error("test socket closed before ACK")); }
      });
    });
  });
  return {
    async send(accountId, fromUid, content, prepare) {
      const deadline = Date.now() + 10_000;
      while (!peers.has(accountId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const peer = peers.get(accountId);
      if (!peer) throw new Error(`no connected test socket for account ${accountId}`);
      const seq = ++sequence;
      const id = String(Date.now() * 1000 + seq);
      content = prepare ? prepare({ messageId: id, messageSeq: seq }) : content;
      const encrypted = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse(JSON.stringify({ type: 1, content })),
        CryptoJS.enc.Utf8.parse(peer.aesKey), { iv: CryptoJS.enc.Utf8.parse(peer.salt),
          mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { peer.pending.delete(id); reject(new Error(`no socket ACK for ${id}`)); }, 5000);
        peer.pending.set(id, { seq, resolve, reject, timer });
        peer.socket.send(frame(0x50, Buffer.concat([Buffer.from([0]), str("test"), str(fromUid), str(fromUid),
          Buffer.from([1]), u32(0), str(`card-e2e-${id}`), u64(id), u32(seq),
          u32(Math.floor(Date.now() / 1000)), Buffer.from(encrypted)])));
      });
    },
    async close() { for (const p of peers.values()) p.socket.terminate(); await new Promise((r) => ws.close(r)); },
  };
}
