/**
 * Test-only OpenClaw plugin. It injects a synthetic Octo DM into the real
 * adapter over encrypted WebSocket so sessions_spawn/yield and HTTP edits are
 * all exercised without requiring a second human/bot account to send inbound.
 * A loopback OpenAI-compatible provider scripts only the model outputs; host
 * tool execution, subagent scheduling, lifecycle, and channel I/O stay real.
 *
 * Installed by the runner only in its UUID-owned private profile.
 *
 * Never ship this directory in the octo package. The runner enables it only
 * for the duration of an explicit container E2E and removes it afterwards.
 */
import { resolveOctoAccount } from "../octo/dist/src/accounts.js";
import { createSocketPeer } from "./socket-peer.mjs";
import { listenServer } from "./server-lifecycle.mjs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { appendEvent, events, ownerKey, inputTag, bindInput, toolCardId } from "./evidence.mjs";

const PROVIDER = "octo-e2e";
const MODEL = "scripted";
const MODEL_REF = `${PROVIDER}/${MODEL}`;
let run;
let testSessions;
let testChildren;
let REQUEST_DIR;
let MODEL_PORT;
let MODEL_SERVER;
function configure(api) {
  const settings = api.pluginConfig ?? api.config?.plugins?.entries?.["octo-host-e2e"]?.config;
  if (!settings?.runId || !/^[0-9a-f-]{36}$/i.test(settings.runId) || !settings.requestRoot?.startsWith(`/var/lib/octo-host-e2e/runs/${settings.runId}/`)) throw new Error("missing owned E2E run configuration");
  if (run && run.runId !== settings.runId) throw new Error("cannot mix E2E run owners in one module");
  run = settings;
  REQUEST_DIR = run.requestRoot; MODEL_PORT = run.modelPort;
  testSessions = globalThis[Symbol.for(`octo.host-e2e.sessions:${run.runId}`)] ??= new Set();
  testChildren = globalThis[Symbol.for(`octo.host-e2e.children:${run.runId}`)] ??= new Set();
  MODEL_SERVER = Symbol.for(`octo.host-e2e.model:${run.runId}`);
}
function ensureEditObserver() {
  const key = Symbol.for(`octo.host-e2e.observer:${run.runId}`);
  if (globalThis[key]) return;
  const currentRun = run;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url ?? "";
    try {
      if (typeof init?.body !== "string") return response;
      const request = JSON.parse(init.body);
      const parsed = new URL(url);
      const authorization = new Headers(init.headers).get("Authorization") ?? "";
      const base = url.slice(0, url.indexOf("/v1/bot/"));
      const owner = ownerKey(base, authorization);
      if (parsed.pathname.endsWith("/v1/bot/sendMessage") && request.payload?.type === 17) {
        const result = await response.clone().json();
        const id = result.message_idstr ?? result.message_id;
        const exact = typeof id === "string" || Number.isSafeInteger(id);
        appendEvent(currentRun, { type: "card-created", owner, channelId: request.channel_id, channelType: request.channel_type,
          messageId: exact ? String(id) : "", clientMsgNo: request.client_msg_no, payload: request.payload,
          ok: response.ok && (!result.client_msg_no || result.client_msg_no === request.client_msg_no) });
      }
      if (parsed.pathname.endsWith("/v1/bot/message/edit")) {
        const envelope = typeof request.content_edit === "string" ? JSON.parse(request.content_edit) : request;
        appendEvent(currentRun, { type: "card-edited", owner, messageId: String(request.message_id ?? ""), envelope, ok: response.ok });
      }
    } catch (error) { console.error(`octo-host-e2e evidence failure: ${error.message}`); }
    return response;
  };
  globalThis[key] = true;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

function scriptedReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const allText = messages.map((message) => contentText(message?.content)).join("\n");
  const marker = allText.match(/(?:CHILD|PARENT)_E2E_OK:([0-9a-f-]{36})/i)?.[1] ??
    allText.match(/FILES_E2E_WORKFLOW:([0-9a-f-]{36})/i)?.[1] ??
    allText.match(/TOOL_DELIVERY_E2E:([0-9a-f-]{36})/i)?.[1] ??
    allText.match(/DISPLAY_DELIVERY_E2E:([0-9a-f-]{36})/i)?.[1] ??
    allText.match(/OpenClaw host E2E marker: ([0-9a-f-]{36})/i)?.[1] ??
    allText.match(/Ordinary user follow-up for ([0-9a-f-]{36})/i)?.[1];
  if (!marker) return { text: "E2E_SCRIPT_ERROR: missing marker" };

  const toolMessages = messages.filter((message) => message?.role === "tool");

  // Reproduces the "every step green but the card says Failed" report: the agent
  // delivers its answer through the `message` tool and ends the turn with no
  // final text. OpenClaw scores this attempt as success (messaging delivery
  // evidence), while the Octo plugin never sees a deliver callback.
  if (allText.includes(`TOOL_DELIVERY_E2E:${marker}`)) {
    const target = allText.match(/TOOL_DELIVERY_TARGET=(\S+)/)?.[1] ?? "";
    if (toolMessages.length === 0) {
      return {
        tool: "exec",
        // Runs long enough to clear FLUSH_DEBOUNCE_MS so the progress card is
        // actually sent before the turn finalizes — same as a real curl step.
        arguments: {
          command: "sleep 2 && printf TOOL_DELIVERY_PREFLIGHT_OK",
          yieldMs: 5_000,
          timeoutSeconds: 15,
          background: false,
        },
        reasoning: "Check the environment before answering.",
        delayMs: 1_200,
      };
    }
    if (toolMessages.length === 1) {
      return {
        tool: "message",
        arguments: {
          action: "send",
          target,
          message: `TOOL_DELIVERY_E2E_SENT:${marker}`,
        },
        reasoning: "Deliver the answer through the messaging tool.",
      };
    }
    // Terminal turn with no assistant text at all.
    return { text: "", reasoning: "The answer is already delivered." };
  }

  // Same terminal shape as the production report, but through the Octo-owned
  // display-card tool: the side effect succeeds and the model returns NO_REPLY.
  if (allText.includes(`DISPLAY_DELIVERY_E2E:${marker}`)) {
    if (toolMessages.length === 0) {
      return {
        tool: "exec",
        arguments: {
          command: "sleep 2 && printf DISPLAY_DELIVERY_PREFLIGHT_OK",
          yieldMs: 5_000,
          timeoutSeconds: 15,
          background: false,
        },
        reasoning: "Check the current time source before rendering the card.",
        delayMs: 1_200,
      };
    }
    if (toolMessages.length === 1) {
      return {
        tool: "octo_send_display_card",
        arguments: {
          // A full UUID intentionally looks secret-like to the display-card
          // sanitizer. Keep the run marker unique without testing against a
          // value that production is expected to remove.
          title: `DISPLAY_DELIVERY_E2E_RUN:${marker.slice(0, 8)}`,
          blocks: [{ type: "text", text: "The requested display card was delivered." }],
        },
        reasoning: "Deliver the requested answer as an Octo display card.",
      };
    }
    return { text: "NO_REPLY", reasoning: "The display card already contains the answer." };
  }

  if (allText.includes(`FILES_E2E_WORKFLOW:${marker}`)) {
    const workDir = `${run.stateRoot}/workspace/file-tools/${marker}`;
    const inputPath = `${workDir}/input.txt`;
    const reportPath = `${workDir}/report.txt`;
    if (toolMessages.length === 0) {
      return {
        tool: "read",
        arguments: { path: inputPath },
        reasoning: "I’ll inspect the source file before making changes.",
      };
    }
    if (toolMessages.length === 1) {
      return {
        tool: "write",
        arguments: { path: reportPath, content: "Processed: alpha=7\n" },
        reasoning: "The input is valid; I’ll write the derived report.",
        // Keep this realistic multi-step task above the progress-card debounce
        // threshold so the test exercises a visible send followed by edits.
        delayMs: 1_200,
      };
    }
    if (toolMessages.length === 2) {
      return {
        tool: "exec",
        arguments: {
          command: `wc -c ${reportPath}`,
          yieldMs: 1_000,
          timeoutSeconds: 10,
          background: false,
        },
        reasoning: "The report is written; I’ll verify its size with a command.",
      };
    }
    return {
      text: `FILES_E2E_OK:${marker}`,
      reasoning: "The read, write, and command checks are complete.",
    };
  }

  if ((allText.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") ||
       allText.includes("[Subagent Context] Every subagent in this batch has now settled")) &&
      allText.includes(`CHILD_E2E_OK:${marker}`)) {
    return { text: `PARENT_E2E_OK:${marker}`, reasoning: "Visible reasoning checkpoint." };
  }
  if (allText.includes(`Ordinary user follow-up for ${marker}`)) {
    return { text: `FOLLOWUP_E2E_OK:${marker}`, reasoning: "Visible reasoning checkpoint." };
  }

  const isChild = allText.includes("[Subagent Task]");
  if (isChild) {
    if (toolMessages.length > 0) {
      return { text: `CHILD_E2E_OK:${marker}`, reasoning: "Visible reasoning checkpoint." };
    }
    const delay = Number(allText.match(/sleep (\d+)/)?.[1] ?? 10);
    return {
      tool: "exec",
      arguments: {
        command: `sleep ${delay}`,
        yieldMs: (delay + 5) * 1_000,
        timeoutSeconds: delay + 15,
        background: false,
      },
      reasoning: "Visible reasoning checkpoint.",
    };
  }

  const spawnFinished = toolMessages.some((message) =>
    message?.name === "sessions_spawn" || contentText(message?.content).includes("childSessionKey"));
  if (spawnFinished) {
    return {
      tool: "sessions_yield",
      arguments: {},
      delayMs: 2_000,
      reasoning: "Visible reasoning checkpoint.",
    };
  }
  const preflightFinished = toolMessages.some((message) =>
    message?.name === "exec" || contentText(message?.content).includes("OCTO_TOOL_E2E_OK"));
  if (!preflightFinished) {
    return {
      tool: "exec",
      arguments: {
        command: "printf OCTO_TOOL_E2E_OK",
        yieldMs: 1_000,
        timeoutSeconds: 10,
        background: false,
      },
      reasoning: "Visible reasoning checkpoint. Verify the tool input and result before delegation.",
    };
  }
  const delay = Number(allText.match(/sleep (\d+)/)?.[1] ?? 10);
  return {
    tool: "sessions_spawn",
    arguments: {
      task: `E2E child. Run sleep ${delay}, then return CHILD_E2E_OK:${marker}`,
      label: `octo-host-e2e-${marker}`,
      taskName: "octo_host_e2e_child",
      runtime: "subagent",
      mode: "run",
      context: "isolated",
      model: MODEL_REF,
      cleanup: "delete",
    },
    reasoning: "Visible reasoning checkpoint.",
  };
}

function sendScriptedResponse(res, body, reply) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1_000);
  const model = typeof body?.model === "string" ? body.model : MODEL;
  const toolCall = reply.tool ? {
    id: `call_${randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: { name: reply.tool, arguments: JSON.stringify(reply.arguments ?? {}) },
  } : undefined;
  const finishReason = toolCall ? "tool_calls" : "stop";

  if (body?.stream === true) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const emit = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    emit({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    if (reply.reasoning) {
      emit({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { reasoning_content: reply.reasoning }, finish_reason: null }],
      });
    }
    emit({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: toolCall
          ? { tool_calls: [{ index: 0, ...toolCall }] }
          : { content: reply.text ?? "" },
        finish_reason: null,
      }],
    });
    emit({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
    if (body?.stream_options?.include_usage) {
      emit({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    res.end("data: [DONE]\n\n");
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: toolCall ? null : reply.text ?? "",
        ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
        ...(toolCall ? { tool_calls: [toolCall] } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

function ensureModelServer(api) {
  if (globalThis[MODEL_SERVER]) return;
  const server = http.createServer((req, res) => {
    req.on("error", (error) => lifecycle.fail(error));
    res.on("error", (error) => lifecycle.fail(error));
    if (req.method !== "POST" || req.url !== `/runs/${run.runId}/v1/chat/completions`) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      else req.destroy();
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const reply = scriptedReply(body);
        setTimeout(() => { try { sendScriptedResponse(res, body, reply); } catch (error) { lifecycle.fail(error); } }, reply.delayMs ?? 0);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      }
    });
  });
  const lifecycle = listenServer(server, MODEL_PORT, (error) => {
    console.error(`octo-host-e2e model server: ${error.message}`);
    appendEvent(run, { type: "server-error", message: error.message });
  });
  const socketPeer = createSocketPeer(server, `/runs/${run.runId}/ws`, lifecycle.fail);
  lifecycle.ready.then(() => console.log(`octo-host-e2e: scripted model ready on 127.0.0.1:${MODEL_PORT}`)).catch(() => {});
  globalThis[MODEL_SERVER] = { server, socketPeer, ...lifecycle };
}

function requiredString(params, key) {
  const value = typeof params[key] === "string" ? params[key].trim() : "";
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

function resolveAccountId(config, requested) {
  if (requested) return requested;
  const accounts = config.channels?.octo?.accounts;
  const first = accounts && typeof accounts === "object" ? Object.keys(accounts)[0] : undefined;
  if (!first) throw new Error("no configured Octo account");
  return first;
}

function buildPrompt(kind, marker, childDelaySeconds, targetUid) {
  if (kind === "configure-reasoning") return "/reasoning stream";
  if (kind === "tool-delivery") {
    return [
      `TOOL_DELIVERY_E2E:${marker}.`,
      `TOOL_DELIVERY_TARGET=user:${targetUid}`,
      "First call exec exactly once with command=\"printf TOOL_DELIVERY_PREFLIGHT_OK\", yieldMs=1000, timeoutSeconds=10, background=false.",
      `After exec succeeds, call message exactly once with action="send", target="user:${targetUid}",`,
      `message="TOOL_DELIVERY_E2E_SENT:${marker}".`,
      "The message tool already delivered the answer, so end the turn with no final text at all.",
    ].join(" ");
  }
  if (kind === "display-card-delivery") {
    return [
      `DISPLAY_DELIVERY_E2E:${marker}.`,
      "First call exec exactly once to verify the source.",
      "After exec succeeds, call octo_send_display_card exactly once with a short run marker in its title.",
      "The display card is the answer, so finish with NO_REPLY and no user-visible final text.",
    ].join(" ");
  }
  if (kind === "followup") {
    return `Ordinary user follow-up for ${marker}. Do not call tools. Reply exactly FOLLOWUP_E2E_OK:${marker}`;
  }
  if (kind === "file-tools") {
    const workDir = `${run.stateRoot}/workspace/file-tools/${marker}`;
    return [
      `FILES_E2E_WORKFLOW:${marker}`,
      `Read ${workDir}/input.txt.`,
      `Write the processed value to ${workDir}/report.txt.`,
      "Run wc -c against the report to verify the write.",
      `After all three tools succeed, reply exactly FILES_E2E_OK:${marker}`,
    ].join(" ");
  }
  const childResult = `CHILD_E2E_OK:${marker}`;
  const childTask = [
    `Call exec exactly once with arguments {\"command\":\"sleep ${childDelaySeconds}\",\"yieldMs\":${(childDelaySeconds + 5) * 1_000},\"timeoutSeconds\":${childDelaySeconds + 15},\"background\":false}.`,
    "Do not use process or any other tool.",
    `Only after exec reports exit code 0, reply exactly ${childResult}.`,
    "If exec fails or is interrupted, reply CHILD_E2E_FAILED instead.",
  ].join(" ");
  return [
    `OpenClaw host E2E marker: ${marker}.`,
    "First call exec exactly once with command=\"printf OCTO_TOOL_E2E_OK\", yieldMs=1000, timeoutSeconds=10, background=false.",
    `After exec succeeds, call sessions_spawn exactly once with runtime=\"subagent\", mode=\"run\", context=\"isolated\", model=\"${MODEL_REF}\".`,
    "Do not call agents_list; omit agentId.",
    `Set the child task exactly to ${JSON.stringify(childTask)}.`,
    "After spawn succeeds, do not poll with sessions_list, sessions_history, exec sleep, or any other tool.",
    "Call sessions_yield and end this turn while waiting for the protected completion event.",
    `When that protected child completion event arrives, reply exactly PARENT_E2E_OK:${marker}`,
  ].join(" ");
}

export default {
  id: "octo-host-e2e",
  name: "Octo Host E2E Bridge",
  version: "0.0.0",
  register(api) {
    configure(api);
    ensureEditObserver();
    ensureModelServer(api);
    // Only the production account socket receives messages. This bridge never
    // reads/writes the Octo runtime or calls its inbound handler.
    let watcher;

    // Keep the test deterministic and avoid mutating the operator's default
    // model. The child gets the same explicit model in sessions_spawn.
    api.on("before_model_resolve", (_event, ctx) => {
      if (!testSessions.has(ctx.sessionKey)) return;
      return { providerOverride: PROVIDER, modelOverride: MODEL };
    });

    // A deleted/worker-owned child may no longer be in a session listing. Keep
    // its actual host tool receipt, linked by the accepted spawn key. Never infer
    // successful execution from a scripted model's CHILD_E2E_OK text.
    api.on("after_tool_call", (event, ctx) => {
      const result = event.result;
      if (event.toolName === "sessions_spawn" && testSessions.has(ctx.sessionKey) && !event.error) {
        let child = result?.details?.childSessionKey;
        if (!child) {
          try { child = JSON.parse(contentText(result?.content)).childSessionKey; } catch {}
        }
        if (typeof child === "string") testChildren.add(child);
      }
      if (event.toolName === "exec" && testChildren.has(ctx.sessionKey)) {
        fs.mkdirSync(REQUEST_DIR, { recursive: true });
        fs.appendFileSync(path.join(REQUEST_DIR, "child-tools.jsonl"), JSON.stringify({
          timestampMs: Date.now(), sessionKey: ctx.sessionKey, toolName: "exec",
          success: !event.error && result?.details?.exitCode === 0,
        }) + "\n");
      }
    });

    api.on("before_agent_run", (event, ctx) => {
      bindInput(run, event.prompt, ctx.sessionKey, ctx.runId);
      return { outcome: "pass" };
    });
    api.on("after_tool_call", (event, ctx) => {
      if (event.toolName === "octo_send_display_card" || event.toolName === "octo_send_interactive_card") {
        appendEvent(run, { type: "card-tool", agentRunId: ctx.runId, sessionKey: ctx.sessionKey,
          messageId: toolCardId(event.result), clientMsgNo: event.result?.details?.client_msg_no, ok: !event.error });
      }
    });
    const runRequest = async (params) => {
      try {
        globalThis[MODEL_SERVER].check();
        if (params.runId !== run.runId || !/^[0-9a-f-]{36}$/i.test(params.requestId)) throw new Error("wrong E2E run/request owner");
        const kind = params.kind === "close-flow" || params.kind === "followup" || params.kind === "configure-reasoning" ||
          params.kind === "file-tools" || params.kind === "tool-delivery" ||
          params.kind === "display-card-delivery"
          ? params.kind
          : "spawn";
        const marker = requiredString(params, "marker");
        if (!/^[0-9a-f-]{36}$/i.test(marker)) throw new Error("invalid flow marker");
        const targetUid = requiredString(params, "targetUid");
        const delay = Number(params.childDelaySeconds ?? 25);
        if (!Number.isInteger(delay) || delay < 10 || delay > 90) {
          throw new Error("childDelaySeconds must be an integer between 10 and 90");
        }

        const config = api.runtime.config.current();
        const accountId = resolveAccountId(
          config,
          typeof params.accountId === "string" ? params.accountId.trim() : "",
        );
        const account = resolveOctoAccount({ cfg: config, accountId });
        if (!account.configured || !account.config.botToken) {
          throw new Error(`Octo account ${accountId} is not configured`);
        }
        const { sessionKey } = api.runtime.channel.routing.resolveAgentRoute({
          cfg: config, channel: "octo", accountId, peer: { kind: "direct", id: targetUid },
        });
        if (params.sessionKey && params.sessionKey !== sessionKey) throw new Error("request differs from host Octo route");
        testSessions.add(sessionKey);
        const { socketPeer } = globalThis[MODEL_SERVER];
        const lockDir = path.join(REQUEST_DIR, "flows", createHash("sha256").update(sessionKey).digest("hex"));
        fs.mkdirSync(path.dirname(lockDir), { recursive: true });
        if (kind === "configure-reasoning") {
          try { fs.mkdirSync(lockDir); } catch (e) { if (e.code === "EEXIST") throw new Error("another flow owns this session"); throw e; }
          fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ marker, sessionKey }));
        } else {
          const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
          if (owner.marker !== marker || owner.sessionKey !== sessionKey) throw new Error("flow owner mismatch");
        }
        if (kind === "close-flow") {
          fs.rmSync(lockDir, { recursive: true });
          return { ok: true, closed: true, runId: run.runId, requestId: params.requestId, marker, sessionKey };
        }
        if (kind === "configure-reasoning") await socketPeer.send(accountId, targetUid, "/new");
        const command = kind === "configure-reasoning";
        if (!command && kind !== "followup" && events(run).some((e) => e.type === "input" && e.marker === marker && e.kind !== "followup")) {
          throw new Error("flow already has a primary injected request");
        }
        const raw = buildPrompt(kind, marker, delay, targetUid);
        const owner = ownerKey(account.config.apiUrl, `Bearer ${account.config.botToken}`);
        const ack = await socketPeer.send(accountId, targetUid, raw, ({ messageId }) => {
          if (!command) appendEvent(run, { type: "input", requestId: params.requestId, marker, sessionKey, messageId,
            kind, owner, channelId: targetUid, channelType: 1 });
          return command ? raw : `${raw}\n${inputTag(run.runId, params.requestId, messageId)}`;
        });
        if (!command) appendEvent(run, { type: "ack", requestId: params.requestId, messageId: ack.messageId });
        return { ok: true, accepted: true, kind, marker, sessionKey, runId: run.runId, requestId: params.requestId, transport: "websocket", ...ack };

      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    const processRequests = () => {
      let names = [];
      try { names = fs.readdirSync(REQUEST_DIR); } catch { return; }
      for (const name of names) {
        if (!name.endsWith(".request.json")) continue;
        const requestPath = path.join(REQUEST_DIR, name);
        const processingPath = path.join(
          REQUEST_DIR,
          name.replace(/\.request\.json$/, ".processing.json"),
        );
        try {
          // OpenClaw can register this test plugin in both gateway and embedded
          // agent runtimes. Rename is the cross-instance claim: exactly one
          // watcher gets to inject a given synthetic inbound message.
          fs.renameSync(requestPath, processingPath);
        } catch {
          continue;
        }
        void (async () => {
          const resultPath = path.join(REQUEST_DIR, name.replace(/\.request\.json$/, ".result.json"));
          try {
            const params = JSON.parse(fs.readFileSync(processingPath, "utf8"));
            if (params.requestId !== name.replace(/\.request\.json$/, "")) throw new Error("request file identity mismatch");
            const result = await runRequest(params);
            fs.writeFileSync(resultPath, JSON.stringify(result));
          } catch (error) {
            fs.writeFileSync(resultPath, JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }));
          } finally {
            try { fs.unlinkSync(processingPath); } catch {}
          }
        })();
      }
    };

    const startWatcher = async () => {
      await globalThis[MODEL_SERVER].ready;
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
      watcher?.close();
      watcher = fs.watch(REQUEST_DIR, processRequests);
      processRequests();
      api.logger.info("octo-host-e2e: request bridge ready");
    };
    // Embedded/tool-discovery registrations must not consume Gateway requests.
    api.on("gateway_start", startWatcher);
    api.on("gateway_stop", () => {
      watcher?.close();
      watcher = undefined;
    });
  },
};
