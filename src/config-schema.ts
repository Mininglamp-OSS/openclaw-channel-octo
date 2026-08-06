// Plain config types — no external dependencies

/**
 * Authorization scope for the `/fork` command (spec §5.4). v1 reads only the
 * default (`owner-mentioned`); wiring inbound to honor a configured value is a
 * v1.1 TODO. The schema accepts all four so a future config that sets it does
 * not fail validation today.
 */
export type ForkCommandScope = "owner-mentioned" | "any-mentioned" | "owner-only" | "any";
export type ReasoningCardTemplateMode = "off" | "shadow" | "experimental";

/** Per-command configuration (top-level only; not per-account in v1). */
export interface OctoCommandsConfig {
  fork?: {
    scope?: ForkCommandScope;
  };
}

export interface OctoAccountConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiUrl?: string;
  wsUrl?: string;
  cdnUrl?: string;  // CDN base URL for media files (e.g. https://cdn.example.com/bucket)
  pollIntervalMs?: number;
  eventWaitSeconds?: number;  // Long-poll hold for /v1/bot/events; 0/unset = short poll at pollIntervalMs
  heartbeatIntervalMs?: number;
  requireMention?: boolean;
  botUid?: string;
  historyLimit?: number;  // 群聊历史消息条数限制（默认20）
  historyPromptTemplate?: string;  // Template for group history context injection
  cardProgress?: boolean;  // false force-disables automatic progress cards; true/unset follows server capabilities
  reasoningCardTemplateMode?: ReasoningCardTemplateMode;  // off=Model B, shadow=discover only, experimental=Model A when compatible
  cardDisplay?: boolean;  // false force-disables the display-card tool; true/unset follows server capabilities
  cardInteraction?: boolean;  // false force-disables interactive cards; true/unset follows server capabilities
  cardToolDetail?: boolean;  // opt-in: true = additive structural summary (unclassifiable tokens masked); false/unset = program name only
  onBehalfOf?: string;  // Persona clone: grantor uid — bot acts on behalf of this human
  secretsFileRoot?: string;  // Jail root for write-secret: secret files may only be written under this path. When unset, defaults to the agent's workspace (agents.list[].workspace matched to the agent, else agents.defaults.workspace); if neither resolves, write-secret fails closed (no process.cwd() fallback).
  dispatchTimeoutMs?: number;  // Explicit per-inbound dispatch timeout override (ms). Unset = derived from agents.defaults.timeoutSeconds + 60s buffer (issue #113).
}

export interface OctoConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiUrl?: string;
  wsUrl?: string;
  cdnUrl?: string;  // CDN base URL for media files (e.g. https://cdn.example.com/bucket)
  pollIntervalMs?: number;
  eventWaitSeconds?: number;  // Long-poll hold for /v1/bot/events; 0/unset = short poll at pollIntervalMs
  heartbeatIntervalMs?: number;
  requireMention?: boolean;
  botUid?: string;
  historyLimit?: number;  // 群聊历史消息条数限制（默认20）
  historyPromptTemplate?: string;  // Template for group history context injection
  cardProgress?: boolean;  // Top-level default for automatic progress cards
  reasoningCardTemplateMode?: ReasoningCardTemplateMode;  // Top-level Registry migration mode for reasoning cards
  cardDisplay?: boolean;  // Top-level default for the display-card tool
  cardInteraction?: boolean;  // Top-level default for interactive cards
  cardToolDetail?: boolean;  // Top-level default for tool-step summary detail (opt-in; unset = off)
  onBehalfOf?: string;  // Persona clone: grantor uid — bot acts on behalf of this human
  secretsFileRoot?: string;  // Jail root for write-secret (see OctoAccountConfig)
  dispatchTimeoutMs?: number;  // Explicit per-inbound dispatch timeout override (ms); see OctoAccountConfig
  commands?: OctoCommandsConfig;  // Per-command config (e.g. commands.fork.scope); v1 reads defaults only
  accounts?: Record<string, OctoAccountConfig | undefined>;
}

// Default English template for history prompt (supports {messages}, {count} placeholders)
export const DEFAULT_HISTORY_PROMPT_TEMPLATE =
  "[Group Chat History] Below are messages from others since your last reply (sender is user ID, body is message content):\n```json\n{messages}\n```\nPlease respond to the current @mention based on this context.\n\n";

// Shared description for secretsFileRoot, kept identical to the wording in
// openclaw.plugin.json so the Control UI and the runtime schema never drift
// (manifest-schema-sync.test.ts asserts this).
export const SECRETS_FILE_ROOT_DESCRIPTION =
  "Jail root for write-secret: secret files may only be written under this path. When unset, defaults to the agent's workspace (agents.list[].workspace matched to the agent, else agents.defaults.workspace). If neither resolves to a usable directory, write-secret is unavailable (fail-closed); there is no process working-directory fallback.";

// Shared description for dispatchTimeoutMs, kept identical to the wording in
// openclaw.plugin.json (manifest-schema-sync.test.ts asserts key-level sync).
// Semantics (issue #113): this timeout is the per-group-queue infrastructure
// backstop from issue #75, NOT an agent-run timeout. When unset it is DERIVED
// as (agents.defaults.timeoutSeconds ?? 600) * 1000 + 60000, so it always
// fires strictly after OpenClaw core's own agent-run timeout.
export const DISPATCH_TIMEOUT_MS_DESCRIPTION =
  "Per-inbound dispatch timeout in milliseconds (infrastructure backstop that releases the per-group queue when an upstream dispatch hangs). When unset, derived from agents.defaults.timeoutSeconds (default 600) as timeoutSeconds*1000 + 60000, so it always fires after the agent-run timeout. Set explicitly only when you need to decouple it from the agent timeout.";

export const CARD_PROGRESS_DESCRIPTION =
  "When omitted or true, follow the server card capability gate; false force-disables automatic progress cards. Per-account values override the top-level value.";

export const REASONING_CARD_TEMPLATE_MODE_DESCRIPTION =
  "Registry migration mode for automatic reasoning progress cards. off keeps local Model B rendering, shadow validates discovery while still sending Model B, and experimental sends Model A when exactly one compatible Bot-catalog template is advertised, using its manifest version unchanged; zero or multiple compatible entries fall back to Model B because catalog order is not a preference signal. A rejected experimental first frame retries once as Model B only for a deterministic card-invalid response; timeouts, conflicts, and transient/server errors do not trigger that fallback. Defaults to experimental; per-account values override the top-level value.";

const REASONING_CARD_TEMPLATE_MODE_SCHEMA = {
  type: "string" as const,
  enum: ["off", "shadow", "experimental"] as const,
  default: "experimental" as const,
  description: REASONING_CARD_TEMPLATE_MODE_DESCRIPTION,
};

export const CARD_DISPLAY_DESCRIPTION =
  "When omitted or true, follow the server card capability gate; false force-disables the octo_send_display_card tool. Per-account values override the top-level value.";

export const CARD_INTERACTION_DESCRIPTION =
  "When omitted or true, follow the server octo/v2 card capability gate; false force-disables the octo_send_card tool and new interactive callback polling. Per-account values override the top-level value.";

export const CARD_TOOL_DETAIL_DESCRIPTION =
  "Opt-in. Omitted or false: progress-card tool steps render the program name only, with paths shortened and URLs reduced to their registrable domain. true: render an additive structural summary of each tool call \u2014 program name, subcommands, flag names, reduced URLs and full file paths \u2014 with every assignment value, and every token that cannot be positively classified as safe, replaced by ***. The summary is built by adding back what is recognised rather than by removing what looks dangerous, so a shape the classifier misses becomes another *** instead of a rendered credential. Residuals, enumerated: a positional token renders when it is at most 24 characters and not high-entropy, so a credential used as a bare argument (deploy prod hunter2) reads as a subcommand; a URL that parses renders with host and path, so a tunnel or presigned hostname whose randomness is the credential still appears; a credential-shaped flag masks one following word, so an unquoted multi-word secret keeps everything after its first token; and file paths are expanded rather than shortened, exposing home directories and workspace layout. Keeping that list short costs single-dash flags: only -x and -xy render, since a glued password and a long flag name are the same shape. Progress cards are visible to every member of a group. The process tool renders its action at every level. Per-account values override the top-level value.";

export const EVENT_WAIT_SECONDS_DESCRIPTION =
  "Seconds to let the server hold an empty /v1/bot/events queue open (its `wait` parameter), so a card action reaches the bot as soon as it happens instead of on the next poll tick. Omitted or 0 keeps plain short polling at pollIntervalMs; a non-zero value below 5 is raised to 5, because shorter holds issue more requests than the short polling they replace. Requires a server that supports the long poll; older servers ignore the field and answer immediately, which is safe but gives no benefit. The client request timeout is derived from this value, and the server clamps it to 30s. Per-account values override the top-level value.";

// Shared description for commands.fork.scope, kept identical to the wording in
// openclaw.plugin.json (manifest-schema-sync.test.ts asserts key-level sync).
export const FORK_SCOPE_DESCRIPTION =
  "Authorization scope for the /fork command. v1 honors only the default (owner-mentioned); wiring inbound to read a configured value is a v1.1 TODO. The enum accepts all four values so a future config does not fail validation today.";

// Reusable JSON Schema fragment for the `commands` block (top-level only in v1).
const COMMANDS_SCHEMA = {
  type: "object" as const,
  properties: {
    fork: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["owner-mentioned", "any-mentioned", "owner-only", "any"],
          default: "owner-mentioned",
          description: FORK_SCOPE_DESCRIPTION,
        },
      },
    },
  },
};

// JSON Schema for OpenClaw plugin config validation
export const OctoConfigJsonSchema = {
  schema: {
    type: "object" as const,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      botToken: { type: "string" },
      apiUrl: { type: "string" },
      wsUrl: { type: "string" },
      cdnUrl: { type: "string" },
      pollIntervalMs: { type: "number", minimum: 500 },
      eventWaitSeconds: { type: "number", minimum: 0, maximum: 30, description: EVENT_WAIT_SECONDS_DESCRIPTION },
      heartbeatIntervalMs: { type: "number", minimum: 5000 },
      requireMention: { type: "boolean" },
      botUid: { type: "string" },
      historyLimit: { type: "number", minimum: 1, maximum: 100 },
      historyPromptTemplate: { type: "string" },
      cardProgress: { type: "boolean", description: CARD_PROGRESS_DESCRIPTION },
      reasoningCardTemplateMode: REASONING_CARD_TEMPLATE_MODE_SCHEMA,
      cardDisplay: { type: "boolean", description: CARD_DISPLAY_DESCRIPTION },
      cardInteraction: { type: "boolean", description: CARD_INTERACTION_DESCRIPTION },
      cardToolDetail: { type: "boolean", description: CARD_TOOL_DETAIL_DESCRIPTION },
      onBehalfOf: { type: "string" },
      secretsFileRoot: { type: "string", description: SECRETS_FILE_ROOT_DESCRIPTION },
      dispatchTimeoutMs: { type: "number", minimum: 1000, description: DISPATCH_TIMEOUT_MS_DESCRIPTION },
      commands: COMMANDS_SCHEMA,
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            botToken: { type: "string" },
            apiUrl: { type: "string" },
            wsUrl: { type: "string" },
            cdnUrl: { type: "string" },
            pollIntervalMs: { type: "number", minimum: 500 },
            eventWaitSeconds: { type: "number", minimum: 0, maximum: 30, description: EVENT_WAIT_SECONDS_DESCRIPTION },
            heartbeatIntervalMs: { type: "number", minimum: 5000 },
            requireMention: { type: "boolean" },
            botUid: { type: "string" },
            historyLimit: { type: "number", minimum: 1, maximum: 100 },
            historyPromptTemplate: { type: "string" },
            cardProgress: { type: "boolean", description: CARD_PROGRESS_DESCRIPTION },
            reasoningCardTemplateMode: REASONING_CARD_TEMPLATE_MODE_SCHEMA,
            cardDisplay: { type: "boolean", description: CARD_DISPLAY_DESCRIPTION },
            cardInteraction: { type: "boolean", description: CARD_INTERACTION_DESCRIPTION },
            cardToolDetail: { type: "boolean", description: CARD_TOOL_DETAIL_DESCRIPTION },
            onBehalfOf: { type: "string" },
            secretsFileRoot: { type: "string", description: SECRETS_FILE_ROOT_DESCRIPTION },
            dispatchTimeoutMs: { type: "number", minimum: 1000, description: DISPATCH_TIMEOUT_MS_DESCRIPTION },
          },
        },
      },
    },
  },
};
