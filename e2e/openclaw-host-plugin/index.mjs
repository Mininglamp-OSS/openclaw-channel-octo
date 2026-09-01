/**
 * Test-only OpenClaw plugin. It injects a synthetic Octo DM into the real
 * adapter so the host, sessions_spawn/yield lifecycle, and Octo HTTP edits are
 * all exercised without requiring a second human/bot account to send inbound.
 * A loopback OpenAI-compatible provider scripts only the model outputs; host
 * tool execution, subagent scheduling, lifecycle, and channel I/O stay real.
 *
 * Install beside the active plugin:
 *   ~/.openclaw-dev/extensions/octo-host-e2e
 *
 * Never ship this directory in the octo package. The runner enables it only
 * for the duration of an explicit container E2E and removes it afterwards.
 */
import { resolveOctoAccount } from "../octo/dist/src/accounts.js";
import { handleInboundMessage } from "../octo/dist/src/inbound.js";
import { setOctoRuntime } from "../octo/dist/src/runtime.js";
import { ChannelType, MessageType } from "../octo/dist/src/types.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SESSION_PREFIX = "agent:main:octo-host-e2e:";
const PROVIDER = "octo-e2e";
const MODEL = "scripted";
const MODEL_REF = `${PROVIDER}/${MODEL}`;
const MODEL_PORT = 19123;
const REQUEST_DIR = "/tmp/octo-host-e2e";
const EDIT_LOG = `${REQUEST_DIR}/card-edits.jsonl`;
const MODEL_SERVER = Symbol.for("octo.host-e2e.model-server");
const EDIT_OBSERVER = Symbol.for("octo.host-e2e.edit-observer");

function ensureEditObserver(api) {
  if (globalThis[EDIT_OBSERVER] || typeof globalThis.fetch !== "function") return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input?.url ?? "";
    if (url.endsWith("/v1/bot/message/edit") && typeof init?.body === "string") {
      try {
        const request = JSON.parse(init.body);
        const envelope = typeof request.content_edit === "string"
          ? JSON.parse(request.content_edit)
          : request.template_ref ? request : undefined;
        if (!envelope) return response;
        fs.mkdirSync(REQUEST_DIR, { recursive: true });
        fs.appendFileSync(EDIT_LOG, JSON.stringify({
          timestampMs: Date.now(),
          messageId: String(request.message_id ?? ""),
          status: response.status,
          ok: response.ok,
          transient: envelope.transient === true,
          plain: typeof envelope.plain === "string" ? envelope.plain : "",
          ...(envelope.template_ref ? { templateRef: envelope.template_ref } : {}),
          ...(typeof envelope.state === "string" ? { state: envelope.state } : {}),
          ...(envelope.data && typeof envelope.data === "object" ? { data: envelope.data } : {}),
          ...(Number.isSafeInteger(envelope.card_seq) ? { cardSeq: envelope.card_seq } : {}),
        }) + "\n");
      } catch (error) {
        api.logger.warn(`octo-host-e2e edit observer: ${error}`);
      }
    }
    return response;
  };
  globalThis[EDIT_OBSERVER] = true;
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
          timeout: 15,
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
          timeout: 15,
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
    const workDir = `/tmp/octo-realistic-e2e/${marker}`;
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
          timeout: 10,
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

  if (allText.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") &&
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
        timeout: delay + 15,
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
      arguments: { message: "Waiting for protected child completion event." },
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
        timeout: 10,
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
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
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
        setTimeout(() => sendScriptedResponse(res, body, reply), reply.delayMs ?? 0);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      }
    });
  });
  server.on("error", (error) => {
    if (error?.code !== "EADDRINUSE") api.logger.error(`octo-host-e2e model server: ${error}`);
  });
  server.listen(MODEL_PORT, "127.0.0.1", () => {
    api.logger.info(`octo-host-e2e: scripted model ready on 127.0.0.1:${MODEL_PORT}`);
  });
  globalThis[MODEL_SERVER] = server;
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
      "First call exec exactly once with command=\"printf TOOL_DELIVERY_PREFLIGHT_OK\", yieldMs=1000, timeout=10, background=false.",
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
    const workDir = `/tmp/octo-realistic-e2e/${marker}`;
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
    `Call exec exactly once with arguments {\"command\":\"sleep ${childDelaySeconds}\",\"yieldMs\":${(childDelaySeconds + 5) * 1_000},\"timeout\":${childDelaySeconds + 15},\"background\":false}.`,
    "Do not use process or any other tool.",
    `Only after exec reports exit code 0, reply exactly ${childResult}.`,
    "If exec fails or is interrupted, reply CHILD_E2E_FAILED instead.",
  ].join(" ");
  return [
    `OpenClaw host E2E marker: ${marker}.`,
    "First call exec exactly once with command=\"printf OCTO_TOOL_E2E_OK\", yieldMs=1000, timeout=10, background=false.",
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
    ensureEditObserver(api);
    ensureModelServer(api);
    setOctoRuntime(api.runtime);
    let watcher;

    // Keep the test deterministic and avoid mutating the operator's default
    // model. The child gets the same explicit model in sessions_spawn.
    api.on("before_model_resolve", (_event, ctx) => {
      if (!ctx.sessionKey?.startsWith(SESSION_PREFIX)) return;
      return { providerOverride: PROVIDER, modelOverride: MODEL };
    });

    const runRequest = async (params) => {
      try {
        const kind = params.kind === "followup" || params.kind === "configure-reasoning" ||
          params.kind === "file-tools" || params.kind === "tool-delivery" ||
          params.kind === "display-card-delivery"
          ? params.kind
          : "spawn";
        const marker = requiredString(params, "marker");
        const targetUid = requiredString(params, "targetUid");
        const sessionKey = requiredString(params, "sessionKey");
        if (!sessionKey.startsWith(SESSION_PREFIX)) {
          throw new Error(`sessionKey must start with ${SESSION_PREFIX}`);
        }
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
        const now = Date.now();
        await handleInboundMessage({
          account,
          botUid: accountId,
          message: {
            message_id: `host-e2e-${kind}-${marker}`,
            message_seq: now,
            from_uid: targetUid,
            channel_id: targetUid,
            channel_type: ChannelType.DM,
            timestamp: Math.floor(now / 1000),
            payload: {
              type: MessageType.Text,
              content: buildPrompt(kind, marker, delay, targetUid),
            },
          },
          groupHistories: new Map(),
          lastBotReplySeqMap: new Map(),
          memberMap: new Map([["E2E User", targetUid]]),
          uidToNameMap: new Map([[targetUid, "E2E User"]]),
          groupCacheTimestamps: new Map(),
          memberRobotMap: new Map([[targetUid, false]]),
          routeOverride: { sessionKey, agentId: "main" },
          log: api.logger,
        });
        return { ok: true, accepted: true, kind, marker, sessionKey };
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

    const startWatcher = () => {
      fs.mkdirSync(REQUEST_DIR, { recursive: true });
      watcher?.close();
      watcher = fs.watch(REQUEST_DIR, processRequests);
      processRequests();
      api.logger.info("octo-host-e2e: request bridge ready");
    };
    startWatcher();
    api.on("gateway_start", startWatcher);
    api.on("gateway_stop", () => {
      watcher?.close();
      watcher = undefined;
    });
  },
};
