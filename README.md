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

`cardProgress`, `reasoningCardTemplateMode`, `cardDisplay`, and `cardInteraction` may also be set directly under `channels.octo` as defaults for every account. An explicit per-account value overrides the corresponding top-level value.

- `botToken` (required): Bot token. Either a User Bot token from BotFather (`bf_` prefix, full group + thread access) or an App Bot token from the Octo admin console (`app_` prefix, direct-message only — server-enforced).
- `apiUrl` (required): Octo server REST API base URL (e.g. `https://your-server/api`). The default `http://localhost:8090/api` only works for a local Octo dev server with the standard `/api` mount.
- `wsUrl` (optional): WebSocket URL. Auto-detected from `apiUrl` if omitted.
- `cdnUrl` (optional): CDN base URL for media files
- `requireMention` (optional): Only respond when @mentioned in groups
- `pollIntervalMs` (optional): Short-poll interval for `card_action` callbacks after this account sends an interactive card (default `2000`, minimum `500`).
- `eventWaitSeconds` (optional): Seconds to let the server hold an empty `/v1/bot/events` queue open, so a card action reaches the bot as soon as it is clicked instead of on the next poll tick (default `0` = plain short polling at `pollIntervalMs`; a non-zero value is clamped to 5–30 — below 5 a hold issues more requests than the short polling it replaces, and 30 matches the server's own clamp). Requires a server that supports the long poll; older servers answer immediately and the poller falls back to `pollIntervalMs` pacing, so setting it is safe but gives no benefit. Lower it if a reverse proxy in front of the server has an idle timeout below ~40s, since the client request timeout is derived as `eventWaitSeconds + 10s`.
- `cardProgress` (optional): Set `false` to force-disable automatic progress cards for this account. Omitted or `true` follows the server card capability gate.
- `reasoningCardTemplateMode` (optional): Registry migration mode for automatic reasoning cards. `experimental` (default) sends Model A when the server advertises exactly one compatible `ai.reasoning-process` template and uses that manifest version unchanged, without a local version allowlist. Compatibility includes exactly one copy of every required view/state, rejects unknown Submit actions, and accepts either no controls or the deployed view-scoped controls (`reasoning_stop` on active, `reasoning_retry` on error, none on result). Zero or multiple compatible entries fall back to Model B because catalog order is not a preference signal. `off` keeps local Model B rendering; `shadow` validates Registry discovery but still sends Model B. This does not affect `octo_send_display_card` or `octo_send_card`. Separately, when OpenClaw reasoning visibility is enabled (`on` or `stream`), sanitized and length-bounded reasoning text is included in progress cards and is visible to channel members. Note that this changes the local Model B card too: whenever Model B is the one rendering — `off`, `shadow`, or `experimental` with no single compatible template — a turn that actually captured reasoning text uses the reasoning layout instead of the plain progress card.

  Four `experimental` behaviours are deliberate and worth knowing before you enable it. Template compatibility alone selects Model A, independent of reasoning visibility: a turn that never exposed any reasoning still renders the `ai.reasoning-process` card, with real tool rows under a generic placeholder thought line instead of captured reasoning text (local Model B rendering keeps its plain progress card in that case). Model A never synthesizes tool actions it did not observe, so a reasoning phase that has not yet run a tool is omitted from the frame — its thought text appears once that phase calls one, where Model B shows the phase immediately with a synthetic `think` row; a turn's last reasoning phase usually calls no tool before the model answers, so that closing segment usually never reaches the Model A card at all. Neither mode sends a progress card for a turn that calls no tools at all. Run control (stop/regenerate) is not a card action: the deployed template is expected to render no such controls, and this plugin only ACKs view-scoped `reasoning_stop` / `reasoning_retry` as a defensive no-op for cards already sitting in channels and for catalogs that still advertise them, so those buttons do not perform run control. Finally, if the initial Model A send receives a deterministic template-frame rejection and the advertised Model B profile is compatible, the plugin retries that first frame exactly once as Model B; an existing Model A message never switches wire modes.
- `cardDisplay` (optional): Set `false` to hide and reject the `octo_send_display_card` tool for this account. Omitted or `true` follows the server card capability gate.
- `cardInteraction` (optional): Set `false` to hide `octo_send_card` and prevent new interactive-card callback polling for this account. Omitted or `true` follows the server `octo/v2` capability gate.
- `historyLimit` (optional): Group chat history message limit (default: 20)
- `dispatchTimeoutMs` (optional): Per-inbound dispatch timeout in milliseconds — an infrastructure backstop that releases the per-group message queue if an upstream dispatch hangs. When unset, it is derived from OpenClaw's `agents.defaults.timeoutSeconds` (600 if unset) as `timeoutSeconds * 1000 + 60000`, so it always fires *after* the agent-run timeout: the agent terminates gracefully first, and this timeout only catches genuinely hung dispatches. Set explicitly only if you need to decouple it from the agent timeout.

For example, to suppress intermediate progress frames while keeping final display cards available:

```json
{
  "channels": {
    "octo": {
      "accounts": {
        "my_bot": {
          "cardProgress": false,
          "cardDisplay": true,
          "cardInteraction": true
        }
      }
    }
  }
}
```

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

### Query strings are stripped from host-shaped values

Anything this plugin renders into a card goes through one URL-reduction step, and
that step strips the query string off anything it can identify as a host: a
dotted hostname, a single-label host such as `localhost`, or an IPv4 literal. A
query string is where callback codes, signed URLs, session ids and one-time
tokens live, and cards are visible to every member of the channel, so the rule
applies at every sink rather than only to progress cards.

It is stated as *host-shaped* rather than unconditionally, because two shapes are
deliberately left alone and it is better to know which:

- **A bare numeric label** — `8080?code=abc`, `2026?code=abc`. These cannot be
  told apart from ordinary prose such as `10/20?ok=yes` or `2026-08-06?ok=yes`,
  and a `grep` pattern has no program name to fall back to, so withholding would
  render a blank card that reads as a bug.
- **A fragment** — `localhost/cb#code=abc` renders in full. Implicit-flow OAuth
  does return tokens in the fragment, so this is a real gap; it predates this
  option and closing it would also hit `file.ts#L10` and markdown anchors, so it
  is left for its own change rather than folded in here.

Three consequences are worth knowing, because they are not just cosmetic:

- Rich-text blocks may collapse. When more of a string counts as reducible, a
  display card can fall back to a single text block and lose its formatting.
  Text over 4000 characters always takes that fallback, because the reduction
  step bounds its own input (see below).
- **A value you submitted may be echoed back without its query string.** The
  status card that records an interactive submission runs the same reduction over
  the submitted value, so `docs/parser?mode=fast` is frozen into the card as
  `docs/parser`. The card is no longer a verbatim record of what was submitted.
- **`?` is read as a query delimiter even where it was a quantifier.** A `grep`
  pattern of `colou?r=red` renders as `colou`, and `reports/q3?draft=1.pdf`
  renders as `reports/q3`. The rewrite is silent — there is no ellipsis or marker.

Where the shape cannot be reduced cleanly — a quote inside the query string, a
`user:pass@host` whose host is not identifiable, a port that would end in the
middle of a token — the summary is withheld entirely rather than half-rewritten.
A partially rewritten command looks sanitized while still carrying its tail, and
gives the operator no signal that what they are reading has been altered. That
withholding is deliberately blunt, and it costs some ordinary search patterns:
`from:me@x to:you` and `meeting at 10:30@office` render nothing, because they are
the same shape as `guest:guestpw@rabbitmq`. Patterns whose "password" carries no
alphanumeric character (`user:.*@example`) or whose host is not host-shaped
(`email:\s*\S+@\S+`) are exempted and render normally.

The reduction step bounds its own input at 4000 characters. It runs on untrusted
text — a submitted form value, a display name, tool arguments — on synchronous
paths with no error boundary, and its passes are quadratic, so an unbounded input
stalls the plugin's event loop for every account at once.

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
