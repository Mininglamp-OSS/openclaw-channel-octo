import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { listOctoAccountIds, resolveOctoAccount } from "./accounts.js";
import { sendCardMessage, sendMessage, type CardProfileManifest } from "./api-fetch.js";
import { getBotCardProfile, peekBotCardProfile } from "./card-profile-cache.js";
import {
  buildInteractiveCard,
  type CardButtonSpec,
  type CardInputSpec,
  type InteractiveCardBlockSpec,
  type InteractiveCardSpec,
} from "./card-author.js";
import { deriveInteractiveCardCaps } from "./card-caps.js";
import { registerCardSession } from "./card-session.js";
import { INTERACTIVE_CARD_TOOL_NAME, CHANNEL_ID } from "./constants.js";
import { resolveOutboundOctoTarget } from "./actions.js";
import { CARD_INTERACTIVE_PROFILE, CARD_VERSION, type ChannelType } from "./types.js";
import type { CardCaps } from "./card-render.js";
import { requestCardEventPolling } from "./events-poll.js";

const SEND_TIMEOUT_MS = 15_000;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

function ok(details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function error(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], details: null };
}

function normalizeButtons(value: unknown): CardButtonSpec[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      id: typeof raw.id === "string" ? raw.id : "",
      label: typeof raw.label === "string" ? raw.label : "",
      ...(raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? { data: raw.data as Record<string, unknown> }
        : {}),
      ...(raw.style === "positive" || raw.style === "destructive" ? { style: raw.style } : {}),
    };
  });
}

function normalizeInputs(value: unknown): CardInputSpec[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const choices = Array.isArray(raw.choices)
      ? raw.choices.flatMap((choice) => {
          if (!choice || typeof choice !== "object") return [];
          const candidate = choice as Record<string, unknown>;
          return typeof candidate.title === "string" && typeof candidate.value === "string"
            ? [{ title: candidate.title, value: candidate.value }]
            : [];
        })
      : undefined;
    return {
      id: typeof raw.id === "string" ? raw.id : "",
      ...(typeof raw.kind === "string" ? { kind: raw.kind as CardInputSpec["kind"] } : {}),
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
      ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
      ...(choices ? { choices } : {}),
    };
  });
}

function normalizeBlocks(value: unknown): InteractiveCardBlockSpec[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (raw.type === "section") {
      const facts = Array.isArray(raw.facts)
        ? raw.facts.map((fact) => {
            const candidate = fact && typeof fact === "object" ? fact as Record<string, unknown> : {};
            return {
              title: typeof candidate.title === "string" ? candidate.title : "",
              value: typeof candidate.value === "string" ? candidate.value : "",
            };
          })
        : undefined;
      return {
        type: "section",
        ...(typeof raw.title === "string" ? { title: raw.title } : {}),
        ...(typeof raw.text === "string" ? { text: raw.text } : {}),
        ...(facts ? { facts } : {}),
      };
    }
    if (raw.type === "options") {
      const options = Array.isArray(raw.options)
        ? raw.options.map((option) => {
            const candidate = option && typeof option === "object" ? option as Record<string, unknown> : {};
            return {
              title: typeof candidate.title === "string" ? candidate.title : "",
              value: typeof candidate.value === "string" ? candidate.value : "",
            };
          })
        : [];
      return {
        type: "options",
        id: typeof raw.id === "string" ? raw.id : "",
        ...(typeof raw.label === "string" ? { label: raw.label } : {}),
        options,
      };
    }
    return { type: String(raw.type ?? "") } as never;
  });
}

function interactiveGateReason(manifest: CardProfileManifest): string | null {
  if (!manifest.available || manifest.config?.interaction_enabled !== true) {
    return "interactive cards are disabled by the server Bot policy";
  }
  if (!manifest.profiles?.includes(CARD_INTERACTIVE_PROFILE)) return "octo/v2 is not advertised";
  if (manifest.card_version !== CARD_VERSION) return `card_version ${manifest.card_version ?? "missing"} is unsupported`;
  return null;
}

interface Params {
  cfg?: OpenClawConfig;
  agentAccountId?: string;
  agentId?: string;
  sessionKey?: string;
  deliveryContext?: OpenClawPluginToolContext["deliveryContext"];
  messageChannel?: string;
}

export function createInteractiveCardTool(params: Params): any[] {
  const { cfg, agentAccountId, agentId, sessionKey, deliveryContext, messageChannel } = params;
  if (!cfg) return [];
  const ambientChannel = deliveryContext?.channel ?? messageChannel;
  if (ambientChannel && ambientChannel !== CHANNEL_ID) return [];

  try {
    const ids = listOctoAccountIds(cfg);
    const configured = ids
      .map((accountId) => resolveOctoAccount({ cfg, accountId }))
      .filter((account) => account.enabled && account.configured && !!account.config.botToken);
    if (configured.length === 0) return [];
    const discoveryAccountId = deliveryContext?.accountId
      ?? agentAccountId
      ?? (ids.length === 1 ? ids[0] : undefined);
    if (discoveryAccountId) {
      const account = resolveOctoAccount({ cfg, accountId: discoveryAccountId });
      if (account.config.botToken && peekBotCardProfile({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
      })?.config?.interaction_enabled === false) return [];
    } else if (configured.every((account) =>
      !!account.config.botToken && peekBotCardProfile({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
      })?.config?.interaction_enabled === false)) {
      return [];
    }
  } catch {
    return [];
  }

  const tool = {
    name: INTERACTIVE_CARD_TOOL_NAME,
    label: "Octo Send Interactive Card",
    description:
      "Send an interactive Adaptive Card to the current trusted Octo conversation for confirmations, approvals, " +
      "small menus, or short forms. Buttons use Action.Submit and the click returns as a new message in this same " +
      "conversation. The destination cannot be selected in tool arguments. Unsupported deployments automatically " +
      "receive the same choices as plain text. For structured choices, use controlled blocks: one section per option " +
      "and an options block for the Input.ChoiceSet, then keep the submit button label short. " +
      "Never include secrets or use a click as proof of business authorization.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        text: { type: "string" },
        blocks: {
          type: "array",
          maxItems: 20,
          description:
            "Controlled Slack-style body blocks. section={type:'section',title?,text?,facts?:[{title,value}]}; " +
            "options={type:'options',id,label?,options:[{title,value}]} renders an expanded Input.ChoiceSet.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["section", "options"] },
              title: { type: "string" },
              text: { type: "string" },
              facts: {
                type: "array",
                maxItems: 50,
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, value: { type: "string" } },
                  required: ["title", "value"],
                },
              },
              id: { type: "string" },
              label: { type: "string" },
              options: {
                type: "array",
                maxItems: 128,
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, value: { type: "string" } },
                  required: ["title", "value"],
                },
              },
            },
            required: ["type"],
          },
        },
        buttons: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              data: { type: "object" },
              style: { type: "string", enum: ["positive", "destructive"] },
            },
            required: ["id", "label"],
          },
        },
        inputs: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string", enum: ["text", "number", "date", "time", "toggle", "choice"] },
              label: { type: "string" },
              placeholder: { type: "string" },
              choices: {
                type: "array",
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, value: { type: "string" } },
                  required: ["title", "value"],
                },
              },
            },
            required: ["id"],
          },
        },
      },
      required: ["title", "buttons"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> => {
      if (deliveryContext?.channel !== CHANNEL_ID || !deliveryContext.to?.trim()) {
        return error("trusted current Octo delivery context is unavailable");
      }
      const accountId = deliveryContext.accountId
        ?? agentAccountId
        ?? (listOctoAccountIds(cfg).length === 1 ? listOctoAccountIds(cfg)[0] : undefined);
      if (!accountId) return error("current Octo account is unavailable");
      const account = resolveOctoAccount({ cfg, accountId });
      if (!account.enabled || !account.configured || !account.config.botToken) {
        return error("Octo account is not fully configured");
      }
      const target = resolveOutboundOctoTarget(deliveryContext.to, deliveryContext.threadId);
      const spec: InteractiveCardSpec = {
        title: typeof args.title === "string" ? args.title : "",
        ...(typeof args.text === "string" ? { text: args.text } : {}),
        ...(args.blocks !== undefined ? { blocks: normalizeBlocks(args.blocks) } : {}),
        buttons: normalizeButtons(args.buttons),
        ...(args.inputs !== undefined ? { inputs: normalizeInputs(args.inputs) } : {}),
      };
      const baseline = buildInteractiveCard(spec);
      if (!baseline.ok) return error(baseline.error);

      let manifest: CardProfileManifest | null = null;
      let negotiatedCaps: CardCaps | undefined;
      let unsupportedReason = "card profile probe failed";
      try {
        requestCardEventPolling(account.accountId);
        manifest = await getBotCardProfile({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
        });
        if (!manifest.available || manifest.config?.interaction_enabled !== true) {
          return error("interactive cards are disabled by the server Bot policy; use plain text");
        }
        unsupportedReason = interactiveGateReason(manifest) ?? "";
      } catch (probeError) {
        unsupportedReason = `card profile probe failed: ${probeError instanceof Error ? probeError.message : String(probeError)}`;
      }

      let built = baseline;
      if (manifest && !unsupportedReason) {
        negotiatedCaps = deriveInteractiveCardCaps(manifest);
        const strict = buildInteractiveCard(spec, negotiatedCaps);
        if (strict.ok) built = strict;
        else unsupportedReason = strict.error;
      }

      if (unsupportedReason) {
        try {
          await sendMessage({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken,
            channelId: target.channelId,
            channelType: target.channelType as ChannelType,
            content: baseline.plain,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
          return ok({ sent: true, degraded: true, reason: unsupportedReason, channel_id: target.channelId });
        } catch (sendError) {
          return error(`interactive card fallback failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
        }
      }

      try {
        const result = await sendCardMessage({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
          channelId: target.channelId,
          channelType: target.channelType as ChannelType,
          card: built.card,
          plain: built.plain,
          profile: CARD_INTERACTIVE_PROFILE,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        const messageId = result?.message_id?.trim();
        if (!messageId) return error("interactive card send returned no message_id");
        registerCardSession(messageId, {
          ...(sessionKey?.trim()
            ? { sessionKey, ...(agentId ? { agentId } : {}) }
            : {}),
          accountId,
          channelId: target.channelId,
          channelType: target.channelType as ChannelType,
          title: built.title,
          card: built.card,
          plain: built.plain,
          actionLabels: built.actionLabels,
          inputIds: built.inputIds,
          ...(negotiatedCaps?.maxInputTextBytes
            ? { maxInputTextBytes: negotiatedCaps.maxInputTextBytes }
            : {}),
          ...(negotiatedCaps?.maxInputsBytes ? { maxInputsBytes: negotiatedCaps.maxInputsBytes } : {}),
        });
        return ok({ sent: true, message_id: messageId, channel_id: target.channelId });
      } catch (sendError) {
        return error(`interactive card send failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
      }
    },
  };

  return [tool];
}
