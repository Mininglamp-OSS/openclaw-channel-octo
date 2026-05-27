/**
 * openclaw-channel-octo
 *
 * OpenClaw channel plugin for Octo messaging platform.
 * Connects via WebSocket for real-time messaging.
 *
 * Configuration is done exclusively via OpenClaw's standard channel setup:
 *   openclaw channels add --channel octo --bot-token bf_... --http-url ...
 *
 * Or interactively:
 *   openclaw channels add --channel octo
 *
 * This plugin deliberately has NO slash commands that shell out to the
 * openclaw CLI — ClawScan blocks `child_process` imports on install.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getGroupMdForPrompt } from "./src/group-md.js";
import { pendingInboundContext, sessionAccountMap, buildSessionAccountKey } from "./src/inbound.js";
import { resolvePersonaHintForSession } from "./src/persona-prompt.js";
import { setOctoRuntime } from "./src/runtime.js";
import { octoPlugin } from "./src/channel.js";
import { createOctoManagementTools } from "./src/agent-tools.js";

// ---------------------------------------------------------------------------
// Plugin entry — uses defineBundledChannelEntry contract (OpenClaw 2026.5.x+).
//
// configSchema is loaded at module-load time from openclaw.plugin.json so we
// keep the static manifest as single source of truth (avoids drift between
// the JSON schema shipped to ClawHub and the runtime schema OpenClaw asks
// for during config validation).
// ---------------------------------------------------------------------------

function loadConfigSchema(): any {
  // openclaw.plugin.json sits at the package root; index.js after build is
  // at <pkg>/dist/index.js, so go up one level.
  //
  // Wrapped in try/catch because the OpenClaw plugin loader runs us in an
  // isolated module context — if readFileSync fails for any reason (path
  // resolution quirk, missing file in a partial install), throwing here
  // would kill the whole entry module, and the loader would report the
  // generic "missing register/activate" error with no clue what actually
  // failed. Returning {} is a safe fallback: validation still runs but
  // with no constraints.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifestPath = join(here, "..", "openclaw.plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return manifest?.channelConfigs?.octo?.schema ?? {};
  } catch (err) {
    console.warn(`[octo] failed to load configSchema from openclaw.plugin.json: ${(err as Error).message}`);
    return {};
  }
}

export default defineBundledChannelEntry({
  id: "octo",
  name: "Octo",
  description: "OpenClaw Octo channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "octoPlugin",
  },
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setOctoRuntime",
  },
  configSchema: loadConfigSchema(),
  registerFull(api: OpenClawPluginApi) {
    // Register agent tool BEFORE the 'full' mode guard — tool-discovery
    // mode calls registerFull with registrationMode='tool-discovery' and
    // needs to see this tool registration.
    api.registerTool(
      (ctx: OpenClawPluginToolContext) => {
        const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        if (!cfg) return null;
        return createOctoManagementTools({ cfg, agentAccountId: ctx.agentAccountId });
      },
      { names: ['octo_management'] },
    );

    // CRITICAL: both setOctoRuntime AND api.registerChannel MUST be called
    // here, even though the contract's `runtime: {}` and `plugin: {}` fields
    // would auto-invoke them.
    //
    // Why: defineBundledChannelEntry loads src/channel.js and src/runtime.js
    // via loadBundledEntryExportSync — an SDK-internal loader cache that
    // produces module instances DIFFERENT from what our `import` statements
    // produce at this file's top. Under ESM ("type": "module"), those two
    // loaders do not share the module map, so the contract's
    // setChannelRuntime sets _runtime on the SDK-loaded instance, while
    // src/inbound.ts reads getOctoRuntime from the ESM-static-import
    // instance — and finds nothing.
    //
    // The 1.0.4 release "trusted the contract" and dropped these two
    // manual calls; bot WebSocket connected fine but the FIRST inbound
    // message crashed with "Octo runtime not initialized". Verified in
    // /tmp/openclaw/openclaw-2026-05-17.log at 16:16:33.531.
    //
    // The contract's `runtime: {}` and `plugin: {}` fields are kept for
    // contract metadata / non-full registration paths; setup-only entry is
    // declared separately in setup-entry.ts. The real channel + runtime
    // wiring used at message-handling time is what we register here, which
    // OpenClaw's channel registry treats as the authoritative entry (last
    // writer wins).
    //
    // Guard: only wire runtime + channel + hooks in 'full' mode.
    // In 'tool-discovery' or other non-full modes, running these calls
    // would register side effects (WebSocket listener, prompt hook) that
    // are not needed and may interfere with the host's intent.
    if (api.registrationMode !== 'full') return;

    setOctoRuntime(api.runtime);
    api.registerChannel({ plugin: octoPlugin });

    console.log('[octo] registering before_prompt_build hook');
    api.on('before_prompt_build', (_event, ctx) => {
      // Sections destined for the user-prompt context block (group MD,
      // member list, inbound history). These belong to the conversation
      // surface, not the LLM's system identity.
      const contextSections: string[] = [];
      // Sections destined for the LLM system prompt (persona identity).
      // System-level identity instructions must NOT live in the user-prompt
      // prefix or the model can treat them as quotable content.
      const systemSections: string[] = [];

      // 1. Group/Thread MD — wrapped in [GROUP CONTEXT] block
      const groupMdContent = getGroupMdForPrompt(ctx);
      if (groupMdContent) {
        contextSections.push(`[GROUP CONTEXT]\n${groupMdContent}\n[/GROUP CONTEXT]`);
      }

      // 2. Inbound context (member list + history) — outside [GROUP CONTEXT], keeps original format
      const sessionKey = ctx.sessionKey;
      if (sessionKey) {
        const pending = pendingInboundContext.get(sessionKey);
        if (pending) {
          pendingInboundContext.delete(sessionKey);
          if (pending.memberListPrefix) contextSections.push(pending.memberListPrefix);
          if (pending.historyPrefix) contextSections.push(pending.historyPrefix);
        }
      }

      // 3. Persona prompt (GH octo-adapters#68) — for persona-clone bots
      // (account.config.onBehalfOf set), pull the active persona_prompt
      // from the per-account cache and prepend it to the SYSTEM prompt.
      // The cache is hydrated by initPersonaPromptCache() in channel.ts;
      // when this bot is not a persona clone, the lookup returns undefined
      // and we skip.
      //
      // The hook ctx does not expose accountId, so we cannot key the
      // persona cache by sessionKey alone — two persona-clone bots
      // running on the same node can legitimately share a sessionKey
      // (OpenClaw routes per-account but session keys can collide).
      // Keying sessionAccountMap only by sessionKey lets a later inbound
      // overwrite an earlier one and the hook then attaches the WRONG
      // account's persona prompt — a cross-account identity leak called
      // out in PR#69 R3 (Jerry-Xin).
      //
      // Fix: sessionAccountMap is composite-keyed by
      // `${accountId}:${sessionKey}` (see inbound.ts). The resolver
      // iterates every registered persona account and asks
      // sessionAccountMap whether it has been seen on this sessionKey.
      // On 0 / >1 matches we fail safe to "no persona injection".
      const personaHint = sessionKey
        ? resolvePersonaHintForSession({
            sessionKey,
            hasAccountSession: (accountId, sk) =>
              sessionAccountMap.has(buildSessionAccountKey(accountId, sk)),
          })
        : undefined;
      if (personaHint) systemSections.push(personaHint);

      if (contextSections.length === 0 && systemSections.length === 0) return;
      return {
        ...(contextSections.length > 0 ? { prependContext: contextSections.join('\n\n') } : {}),
        ...(systemSections.length > 0 ? { prependSystemContext: systemSections.join('\n\n') } : {}),
      };
    });
  },
});
