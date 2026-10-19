// Synthetic remote Octo HTTP service for disposable card-harness acceptance.
// Host tools, scheduling, templates and edit payloads are produced by real code.
import { createServer } from "node:http";
export const TARGET = "user_card_e2e_00000000000000000000";
const messages = [];
const sequences = new Map();
const server = createServer(async (req, res) => {
  const chunks = []; for await (const b of req) chunks.push(b);
  const text = Buffer.concat(chunks).toString();
  const body = text ? JSON.parse(text) : {};
  const url = new URL(req.url, "http://localhost");
  const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url.pathname === "/v1/bot/register") return json({ robot_id: "bot_card_e2e_000000000000000000000", owner_uid: TARGET,
    im_token: "synthetic-im-token", ws_url: "ws://127.0.0.1:19123/ws?account=scope", api_url: "http://127.0.0.1:19124" });
  if (url.pathname === "/v1/bot/card/profile") return json({ enabled: true, profiles: ["octo/v1", "octo/v2"],
    config: { card_enabled: true, display_enabled: true, interaction_enabled: true, reasoning_enabled: true,
      reasoning_template_ref: { id: "ai.reasoning-process", version: "0.3.0" } },
    templating: { supported: true, wire: "template-ref/v1", templates: [{ id: "ai.reasoning-process", version: "0.3.0", views: [
      { name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: ["reasoning_stop"] },
      { name: "error", states: ["error"], wire_profile: "octo/v2", submit_actions: ["reasoning_retry"] },
      { name: "result", states: ["completed", "stopped"], wire_profile: "octo/v1", submit_actions: [] },
    ] }] } });
  if (url.pathname === "/v1/bot/sendMessage") {
    const id = String(messages.length + 100);
    messages.push({ message_id: id, message_seq: messages.length + 1, timestamp: Math.floor(Date.now() / 1000),
      channel_id: body.channel_id, payload: Buffer.from(JSON.stringify(body.payload)).toString("base64") });
    return json({ message_id: id, message_seq: messages.length, client_msg_no: body.client_msg_no });
  }
  if (url.pathname === "/v1/bot/message/edit") {
    const envelope = typeof body.content_edit === "string" ? JSON.parse(body.content_edit) : body;
    if (!messages.some((m) => m.message_id === String(body.message_id))) return json({ error: "unknown card" }, 404);
    if (envelope.card_seq !== undefined) {
      if (!Number.isSafeInteger(envelope.card_seq) || envelope.card_seq <= (sequences.get(String(body.message_id)) ?? -1)) return json({ error: "stale card_seq" }, 409);
      sequences.set(String(body.message_id), envelope.card_seq);
    }
    return json({});
  }
  if (url.pathname === "/v1/bot/messages/sync") return json({ messages: messages.filter((m) => m.channel_id === body.channel_id) });
  if (url.pathname === "/v1/bot/groups") return json({ groups: [] });
  if (url.pathname === "/v1/bot/user/info") return json({ uid: TARGET, name: "Synthetic User", robot: false });
  if (url.pathname === "/v1/bot/events") return setTimeout(() => json({ results: [] }), Math.max(1, body.wait ?? 1) * 1000);
  if (["/v1/bot/typing", "/v1/bot/readReceipt", "/v1/bot/heartbeat"].includes(url.pathname)) return json({});
  if (["/v1/bot/mention-prefs", "/v1/bot/mention_prefs", "/v1/bot/read"].includes(url.pathname)) return json({}, 404);
  console.error("unsupported synthetic endpoint", req.method, url.pathname);
  return json({}, 404);
});
server.listen(19124, "127.0.0.1", () => console.log("synthetic card service ready"));
