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

### A scheme-less `user:pass@host` is only reduced when the host carries a dot

`postgres://user:pw@host/db` and `user:pw@db.example.com` lose their userinfo, but
a single-label host (`user:pw@localhost`), an IPv6 literal (`user:pw@[::1]`), a
password containing `/` (`user:pa/ss@db.example.com`) and a leading slash
(`/user:pass@localhost`) all render in full.

These are pre-existing gaps and closing them is its own change. The shape is
genuinely ambiguous — `sed 's:a:b@c:g'` and `user:pw@localhost` are the same
string to a matcher — so in review both widening the reduction and adding a
withhold-everything backstop each traded one defect for a worse one. Their exact
current behaviour is pinned in `src/card-render.corpus.ts` so that whatever
closes them cannot silently change anything else.

### The reduction step bounds its own input

The URL reduction runs on untrusted text — a submitted form value, a display
name, tool arguments — on synchronous paths with no error boundary, and its
passes are quadratic, so an unbounded input stalls the plugin's event loop for
every account at once. The bound is 4000 characters.

**One bound is not enough, because the pipeline is not the only thing that scales
with input.** Three other limits sit around it, each closing a path that the
4000-character bound does not reach:

| limit | what it bounds | why the 4000-character bound misses it |
|---|---|---|
| `RAW_INPUT_MAX` (64 KiB) | the whitespace collapse each caller runs first | it runs *before* the bound — 32–92 ms per MB by shape, uncapped |
| `TAIL_SCAN_MAX` (4000) | how much of the discarded tail the guard reads | the guard sees the whole remainder, and its regexes are not all linear |
| `REDUCE_BUDGET_PER_CARD` (120 000) | one card's total across all blocks | per-call and per-block-count limits say nothing about the sum |
| the `exec` summary's own cut (4000) | picking the program name out of a command | it runs *above* the pipeline, so the 4000-character bound never sees it |

Measured against the state before them — paired runs, both versions in one
process, median of 5:

| | before | after |
|---|---|---|
| `sanitizeErrorText`, 64 KB dotless base64 | 4 788 ms | 0.2 ms |
| `sanitizeErrorText`, 256 KB dotless base64 | 77 296 ms | 0.3 ms |
| `sanitizeErrorText`, 4 MB prose | 376 ms | 4.9 ms |
| `sanitizeErrorText`, 4 MB whitespace-dense | 26 ms | 1.4 ms |
| `exec` summary, 4 MB command | 201 ms | 0.2 ms |
| 200 blocks × 3 905 chars, worst rendering shape | 5 383 ms | 856 ms |
| 200 copy blocks × 125 KB | 0.2 ms | 0.2 ms |
| 20-block card of ordinary prose | 1.9 ms | 1.2 ms |
| 200 blocks × 200 chars | 4.4 ms | 4.3 ms |

Ordinary input is unchanged — the bounds cost nothing on anything a person would
actually send.

**The per-card budget bounds characters, not time.** It admits
`120 000 / 4 000 = 30` reductions, and a reduction's cost varies by roughly 500×
with shape: 0.42 ms for prose, 29 ms for a 4 000-character unbroken lowercase run
(the reduction's first pass is quadratic when it finds no `://`, and that is
inside the 4 000-character bound, unchanged by this work). So the worst card is
about **0.9 seconds**, not the "hundreds of milliseconds" an earlier revision of
this section claimed — and about **1.8 seconds** for a card made entirely of rich
segments, which run the pipeline twice while the budget charges once. Both are
well below the 5.4 seconds the same card cost before, but neither is a number to
round down in the telling.

The tail-scan limit is the one that changes a stated rule, so it is worth saying
plainly: **a credential more than 4000 characters past the cut no longer causes
the safe content before it to be withheld.** It cannot cause that credential to
render — only the kept prefix renders, and it faces the guard on its own. What is
given up is the outer layer of fail-closed, "something far away looks wrong, so
hide what is near too". That layer cost 5.5 seconds of stalled event loop on a
single 120 KB block, because the guard's JWT pattern is quadratic on text with no
dots in it, and every `eyJ` in the input is another starting position.

`RAW_INPUT_MAX` **is not output-neutral**, and an earlier revision of this section
claimed it was. That claim then justified truncating at exactly 64 KiB with no
regard for token boundaries — which cut through a `user:pass@host` and rendered
the password in full, the very defect the whitespace rule exists to prevent. The
truncation now lands on whitespace like the reduction's own does. What remains
true is narrower: at most 4000 characters render and at most 4000 more are
scanned, so at a collapse ratio near 1 nothing past 64 KiB could reach either.
Where the ratio is high — heavy runs of whitespace, column-aligned layout — 64 KiB
of raw text may collapse to only a few thousand characters and content after it is
dropped. That is a real availability cost in the safe direction, not an absence of
one. The
per-card budget is charged as `min(collapsed length, 4000)` per string — what the
pipeline actually processes — so a single very long block still renders its first
4000 characters instead of consuming the whole card's allowance and vanishing.

**The cut lands on whitespace, never inside a token.** That is what makes the
bound safe rather than merely fast. Several passes locate what they neutralise by
an anchor — the reduction that removes a `user:pass@host` needs the `@host` to be
there — so a cut through the middle of a token can remove the anchor and leave
the credential rendering in the clear. Cutting on whitespace keeps every token
whole, which also means a secret near the cut is either kept entirely (and caught
by the guards) or dropped entirely, and that a UTF-16 surrogate pair is never
split.

Text with no whitespace anywhere in the first 4001 characters has no safe cut and
is **not rendered**. (4001, not 4000: whitespace sitting at exactly index 4000
means the first 4000 characters are already a token-whole prefix, and that prefix
is kept.) The limit counts **UTF-16 code units, not characters** — CJK prose
carries no ASCII whitespace, so a long Chinese message is a single unbroken token,
and an astral character such as an emoji spends two units, halving the effective
threshold.

**The cut also may not delete evidence the caller's guard was reading.** Severing
a token is not the only harm a bound can do. The guards downstream inspect the
*truncated* string, so a bound that discards the keyword suppressing a credential
turns an input that would have failed closed into one that looks clean — with the
credential at offset 0, where no downstream render cap reaches it. So **every**
truncation runs the caller's own sensitivity predicate over the segment it is
about to discard, and withholds everything if it fires.

*Every* is load-bearing, and it took two rounds to get there. The first version
put that guard only on the 4 000-character bound; the 64 KiB collapse mirrored its
cut rule and not its guard. Adversarial review found the gap:

```
`user:hunter2@localhost ` + ("x" + " "×23)×3000 + ` y token`
```

The trailing `token` is what withholds the whole string. It sits past 64 KiB, so
the collapse dropped it, and the password rendered where the unbounded version
rendered nothing. The window the guard reads must also **end** on whitespace, for
the same reason the cut must: a token straddling the window edge is scanned as a
fragment and matches nothing. `AKIAIOSFODNN7EXAMPLE` starting at offset 7 986 put
14 of its 20 characters inside a naive window, and the pattern needs 16. The
window therefore extends forward to the next whitespace rather than shrinking back
to the previous one — shrinking would exclude the straddling token entirely, which
is the same miss with tidier arithmetic.

One half of this is verified and one half is argued, and they are worth
separating. That the discarded segment is scanned at all is pinned by tests that
go red when the scan is removed. That the scan uses the *caller's* predicate
rather than the default is not observable today: the default is
`isSensitive(_, true)`, the strictest predicate in the module, so passing nothing
can only withhold more, never less. It is passed so the two steps cannot drift if
a caller's predicate ever becomes the more lenient one — a guard against a future
change, not a fix for a present bug.

All three truncation points — the 64 KiB collapse, the 4 000-character reduction
bound, and the `exec` summary's own program-name cut — now call **one**
implementation of the cut rule and one implementation of the scan window. That is
not for reuse. This branch's recurring defect has been a second copy of a rule
that failed to mirror the first: a backstop regex whose character class diverged
from the reducer's, a DSN check keyed on the first `@` where the pass keys on the
last, a corpus field modelling a guard instead of calling it, and the collapse
gap above. Each was fixed by writing the rule correctly a second time. Sharing one
copy is the fix that removes the category.

That predicate is passed in rather than fixed, because there is no single right
answer: `main`'s own behaviour forks by strategy, withholding a trailing long hex
run under `grep` and rendering it under `read`. Hard-coding the strict form blanks
ordinary text ending in a git SHA; hard-coding the lenient form misses a
high-entropy tail. Taking the caller's predicate makes this guard *identical* to
the one downstream by construction, which is the only version that cannot drift.
It checks only the discarded segment: checking the whole string blanks content
the reduction exists to make safe, such as a webhook URL followed by a page of
prose.

That guard is deliberately **stricter** than the downstream one, and the earlier
claim here that they are identical was wrong. It runs before reduction and reads
raw text, so an ordinary documentation link in the discarded tail — any path of
32 characters or more containing a `/` — trips the entropy check that would never
have seen it downstream, and a long error message ending in a docs URL renders
nothing. The apparent repair, bounding and reducing the tail before testing it,
**opens a leak**: when the tail itself exceeds the bound, a credential past its
own 4000th character stops being seen at all, and `main` does see it. Trading a
leak for availability is not a trade this pipeline makes, so the guard reads raw
text and the cost is pinned in `COST_CORPUS`.

**Every input/output pair for all of this lives in `src/card-render.corpus.ts`,
not here.** That is deliberate: this section and the corpus and the PR description
were three hand-maintained descriptions of one function, and they drifted out of
sync with each other and with the code in successive rounds — a claim here was
falsified by a one-line change in the same commit. Prose explains *why*; the
corpus records *what*, is executable, and fails when it stops being true. The
`COST` group carries the availability price with each row's measured `main` output
beside it.

One argument does belong here, because it is reasoning rather than a snapshot.
The obvious repair for the availability cost is to run the first reduction pass —
`new URL()`-based, and it *shrinks* its input — above the bound, and bound only
what is left. **That does not work.** The first pass's regex is quadratic whenever
the text contains no `://`, because the scheme character class consumes the whole
token at every start position before backtracking to look for it: measured alone,
18 ms at 4000 characters, 415 ms at 20 000, **10 877 ms at 100 000**. Only shapes
that *do* contain `://` are cheap (120 000 characters in 1.25 ms), and gating on
`input.includes("://")` does not rescue it — `"a"×100000 + " http://x.com"`
contains `://` and still takes 10 580 ms, because the backtracking happens before
the match is reached. Hoisting would restore the same 9–11 second stall this bound
exists to prevent, on a *wider* trigger: any long unbroken token, no URL syntax
required.

Three sinks apply no render cap of their own, so what the bound does is directly
visible at them:

- **A display-card text block** renders long text in full. It carries no guard of
  its own — an earlier version ran `isSensitive` over the whole untruncated string
  here. The bound's discarded-segment check replaces it at all eleven callers
  instead of one, and drops that version's cost of blanking safe long content.
  The two are not nested: the discarded segment is a *subset* of what the old
  check read, so coverage moved rather than grew. Nothing measurable was lost —
  the shapes only the old check saw are ones the reduction neutralises anyway —
  but "strictly greater" would be the wrong word for it.
- **A copy-to-clipboard block** over the bound is refused rather than truncated,
  with a message that says *characters* — its other limit, 4 KiB, is a byte limit
  and gets its own message. A reader pastes that content somewhere, so a partial
  value is worse than an honest refusal.
- **The status card that echoes an interactive submission** renders a
  member-submitted value through the same reduction, and is the lowest trust
  boundary of the three. It has no guard of its own; it gets the default strict
  predicate.

Those three are where the bound is *visible*, not where it *acts*: it lives inside
`reduceUrlsInText`, so all eleven callers change at long input. Three change in a way
"long text gets truncated" does not predict — a rich text block loses per-segment
styling (the safer output, and it closes a `card ⊋ plain` divergence `main` has),
an authored interactive card rejects an over-long title with a message naming the
wrong cause, and a debug value and a reasoning step both yield `""` rather than a
truncation.

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
