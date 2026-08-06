# openclaw-channel-octo

[![ClawHub](https://img.shields.io/badge/ClawHub-octo-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0id2hpdGUiLz48L3N2Zz4=)](https://clawhub.ai/plugins/octo)

OpenClaw channel plugin for **Octo**. Connects via WebSocket for real-time messaging.

## Prerequisites

- Node.js >= 22 (OpenClaw >= 2026.4.15 requires Node 22)
- OpenClaw installed and configured (`npm i -g openclaw`)
- A bot created via BotFather in Octo (send `/newbot` to BotFather)

## Install

This plugin is published exclusively on ClawHub for fresh installs:

```bash
openclaw plugins install clawhub:octo
```

## Configure a bot account

After installing, use OpenClaw's standard `channels add` flow.

Non-interactive (recommended for scripts and CI):

```bash
openclaw channels add --channel octo \
  --account my_bot \
  --bot-token bf_your_token_here \
  --http-url https://your-server.example/api
```

Interactive (prompts for token and API URL):

```bash
openclaw channels add
```

After the account is written, restart the gateway (`openclaw gateway run --force`)
or wait for the next auto-reload — the plugin watches `channels.octo` and
reconnects on changes.

## Configuration

Bot accounts are stored in `~/.openclaw/openclaw.json` under `channels.octo.accounts`:

```json
{
  "channels": {
    "octo": {
      "enabled": true,
      "accounts": {
        "my_bot": {
          "enabled": true,
          "botToken": "bf_your_token_here",
          "apiUrl": "https://your-server.example/api"
        }
      }
    }
  }
}
```

Configuration fields per account:

Card policy is configured per Bot on the Octo server, not in `openclaw.json`. The plugin reads the effective `card_enabled`, `display_enabled`, `interaction_enabled`, `reasoning_enabled`, and `reasoning_template_ref` values from `GET /v1/bot/card/profile`. Legacy local fields (`cardProgress`, `reasoningCardTemplateMode`, `cardDisplay`, and `cardInteraction`) are ignored.

- `botToken` (required): Bot token. Either a User Bot token from BotFather (`bf_` prefix, full group + thread access) or an App Bot token from the Octo admin console (`app_` prefix, direct-message only — server-enforced).
- `apiUrl` (required): Octo server REST API base URL (e.g. `https://your-server/api`). The default `http://localhost:8090/api` only works for a local Octo dev server with the standard `/api` mount.
- `wsUrl` (optional): WebSocket URL. Auto-detected from `apiUrl` if omitted.
- `cdnUrl` (optional): CDN base URL for media files
- `requireMention` (optional): Only respond when @mentioned in groups
- `pollIntervalMs` (optional): Short-poll interval for `card_action` callbacks after this account sends an interactive card (default `2000`, minimum `500`).
- `eventWaitSeconds` (optional): Seconds to let the server hold an empty `/v1/bot/events` queue open, so a card action reaches the bot as soon as it is clicked instead of on the next poll tick (default `0` = plain short polling at `pollIntervalMs`; a non-zero value is clamped to 5–30 — below 5 a hold issues more requests than the short polling it replaces, and 30 matches the server's own clamp). Requires a server that supports the long poll; older servers answer immediately and the poller falls back to `pollIntervalMs` pacing, so setting it is safe but gives no benefit. Lower it if a reverse proxy in front of the server has an idle timeout below ~40s, since the client request timeout is derived as `eventWaitSeconds + 10s`.
- `historyLimit` (optional): Group chat history message limit (default: 20)
- `dispatchTimeoutMs` (optional): Per-inbound dispatch timeout in milliseconds — an infrastructure backstop that releases the per-group message queue if an upstream dispatch hangs. When unset, it is derived from OpenClaw's `agents.defaults.timeoutSeconds` (600 if unset) as `timeoutSeconds * 1000 + 60000`, so it always fires *after* the agent-run timeout: the agent terminates gracefully first, and this timeout only catches genuinely hung dispatches. Set explicitly only if you need to decouple it from the agent timeout.

Automatic reasoning progress uses only the exact Registry template ref selected by the server and advertised in the same profile response. If reasoning is disabled, the ref is missing/incompatible, or the profile cannot be read, no progress card is sent; the plugin never falls back to the old locally rendered Model B. Profile results are cached privately per Bot and invalidated immediately by the server's `bot_setting_updated` event.

## Agent tools

This plugin registers three agent tools:

- **`octo_management`** covers group/thread/member management, GROUP.md and THREAD.md, voice-correction context, and `write-secret`.
- **`octo_send_display_card`** sends structured, non-callback `octo/v1` cards to the current trusted Octo conversation.
- **`octo_send_card`** sends `octo/v2` confirmation, menu, or short-form cards. Controlled `section`/`options` blocks produce structured body sections and `Input.ChoiceSet` choices instead of one dense text paragraph. A submit click is polled from `/v1/bot/events`, preserves the original card body while showing the selected result, and continues the same conversation as a new agent turn. Unsupported deployments receive the choices as plain text.

These are **plugin tools**, and OpenClaw's `tools.profile` presets
(`minimal`, `coding`, `messaging`, `full`) decide which tools the model sees
*before* it sees them. Only `full` (`allow: ["*"]`) admits plugin tools; the
three restrictive presets exclude plugin tools by default. So under `minimal`,
`coding`, or `messaging`, they are filtered out unless explicitly allowed.

This matters because **a fresh OpenClaw install defaults `tools.profile` to
`coding`**, not `full` — so out of the box an Octo bot cannot use management,
display-card, or interactive-card tools until they are allowed.

To keep the Octo tools available under a restricted profile, add them via
`tools.alsoAllow` (additive on top of the profile, the same way the bundled
`browser` tool is enabled):

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["octo_management", "octo_send_display_card", "octo_send_card"],
  },
}
```

For a single agent, use the same names under `agents.list[].tools.alsoAllow`.

When `octo_management` is filtered out, the plugin injects a short system-prompt
note so the agent attributes the gap correctly (a tools-profile restriction, not
a missing Octo feature) instead of suggesting another platform or asking the user
to paste a secret in plaintext. Whether to adjust the configuration is up to you.

> Security note: `write-secret` exists precisely so users never have to paste a
> plaintext key into chat. If the tool is unavailable because of the profile,
> enable `octo_management` as above — do not work around it by pasting the
> secret in plaintext.

## What it does

1. Registers the bot with the Octo server via REST API
2. Connects to WebSocket for real-time message receiving
3. Auto-reconnects on disconnection
4. Sends a greeting to the bot owner on connect
5. Dispatches incoming messages to OpenClaw's message handler
6. Supports typing indicators and read receipts
7. Sends display and submit-interactive cards with negotiated fallback
8. Polls durable `card_action` events only after an interactive card is sent

## Architecture

`index.ts` is a standard OpenClaw plugin entry. When loaded:

- `api.registerChannel(octoPlugin)` registers the Octo channel runtime
- The bundled `setupEntry` exposes `defineBundledChannelSetupEntry(...)` so
  `openclaw channels add` works without first enabling the plugin
- `setupWizard` + `setup` adapters on `octoPlugin` cover both interactive and
  CLI-flag setup paths
- Configuration is read from `channels.octo` in OpenClaw's config; the plugin
  hot-reloads when that block changes

## Development

Run the real container E2E for yielded progress cards with a configured Octo
DM user. The runner builds this checkout, installs a test-only inbound bridge in
the `ocprobe` container, restarts the real OpenClaw gateway, exercises
`sessions_spawn` + `sessions_yield` + protected completion, and removes the
bridge/config again even when the test fails.

The bridge includes a loopback OpenAI-compatible scripted provider so tool
choices are deterministic. OpenClaw's tool execution, subagent scheduler,
lifecycle stream, and Octo send/edit HTTP requests remain the real host paths.

```bash
OCTO_E2E_TARGET_UID=<octo-user-uid> npm run test:e2e:openclaw
```

Override the default container with `OCTO_E2E_CONTAINER` when needed. The
target user receives progress-card messages during the test.

## Disconnect

To disconnect a bot, send `/disconnect` to BotFather in Octo. This invalidates
the IM token and kicks the WebSocket connection.
