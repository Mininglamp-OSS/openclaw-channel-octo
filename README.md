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
- `docsApiUrl` (optional): Base URL for the docs domain, which is where document comment `@Bot` task replies are posted. It covers **both** doc services: docs-backend (`/v1/bot/docs/**`, Yjs docs) and octo-doc (`/docs-html/v1/**`, HTML docs). Setting it therefore assumes those two share ONE origin; serving them from two different origins is not supported (if a deployment ever needs that, the fix is a separate `htmlDocsApiUrl`, not a heuristic). Omitted means `apiUrl` — correct whenever a single gateway origin fronts the IM server and both doc services, which is how hosted deployments are arranged. Set it only when the doc services answer on a different origin (e.g. a split local stack whose IM gateway has no `/v1/bot/docs` route). Getting this wrong is silent from the user's point of view: the reply POST fails with `404`, which is a permanent failure so it is not retried, and the fallback notice uses the same endpoint so it is lost too — meanwhile the agent has already edited the document, so the document changes and the comment thread stays empty.
- `docTasks` (optional, **default on**): Master switch for document comment `@Bot` tasks. Leaving it unset now enables the feature: the switch is plugin-local with no server-side counterpart, so an opt-in default meant every operator had to discover the flag before a document `@Bot` did anything at all — the observed failure mode was "I @-mentioned the Bot and nothing happened". Set it to the boolean `false` to turn it back off for an account (or at the channel top level for every account), which is the supported way to run an account as a plain IM Bot; a per-account `true` still overrides a channel-level `false`. Only the boolean `true` passes the gate — the default applies to unset/null values only, so a mistyped `docTasks: "true"` is still rejected rather than silently half-enabling. Enabling it means any user who can comment on a document the Bot can read is able to direct that Bot, and the agent session runs with the Bot's own credentials — the Bot's document permissions are therefore the effective ceiling on what a commenter can cause. Slash commands are disabled on this path and comment text only ever enters the session as a quoted value, but the trust boundary is still "whoever can comment can task the Bot", so set `docTasks: false` on any account where that group is not acceptable. Requires `docsApiUrl` (or a single-origin `apiUrl`) to be reachable, otherwise replies are silently lost as described above.
- `wsUrl` (optional): WebSocket URL. Auto-detected from `apiUrl` if omitted.
- `cdnUrl` (optional): CDN base URL for media files
- `requireMention` (optional): Only respond when @mentioned in groups
- `pollIntervalMs` (optional): Short-poll interval for `card_action` callbacks after this account sends an interactive card (default `2000`, minimum `500`).
- `eventWaitSeconds` (optional): Seconds to let the server hold an empty `/v1/bot/events` queue open, so a card action reaches the bot as soon as it is clicked instead of on the next poll tick (default `0` = plain short polling at `pollIntervalMs`; a non-zero value is clamped to 5–30 — below 5 a hold issues more requests than the short polling it replaces, and 30 matches the server's own clamp). Requires a server that supports the long poll; older servers answer immediately and the poller falls back to `pollIntervalMs` pacing, so setting it is safe but gives no benefit. Lower it if a reverse proxy in front of the server has an idle timeout below ~40s, since the client request timeout is derived as `eventWaitSeconds + 10s`.
- `historyLimit` (optional): Group chat history message limit (default: 20)
- `dispatchTimeoutMs` (optional): Per-inbound dispatch timeout in milliseconds — an infrastructure backstop that releases the per-group message queue if an upstream dispatch hangs. When unset, it is derived from OpenClaw's `agents.defaults.timeoutSeconds` (600 if unset) as `timeoutSeconds * 1000 + 60000`, so it always fires *after* the agent-run timeout: the agent terminates gracefully first, and this timeout only catches genuinely hung dispatches. Set explicitly only if you need to decouple it from the agent timeout.

Automatic reasoning progress uses only the exact Registry template ref selected by the server and advertised in the same profile response. If reasoning is disabled, the ref is missing/incompatible, or the profile cannot be read, no progress card is sent; the plugin never falls back to the old locally rendered Model B. Profile results are cached privately per Bot and invalidated immediately by the server's `bot_setting_updated` event.

### Upgrading to the release that makes `docTasks` default on

This is a **breaking change for existing deployments**. Before it, an omitted `docTasks` meant off; after it, every account that never wrote the key accepts document comment `@Bot` tasks on the next restart. Nothing else about the feature changed — the gate, the trust boundary, and the `false` opt-out are all as they were. What changed is who gets it without asking. Three consequences to check before upgrading:

1. **The trust boundary now applies by default.** Anyone who can comment on a document the Bot can read can direct that Bot, and the agent session runs with the Bot's own credentials, so the Bot's document permissions are the effective ceiling on what a commenter can cause. Slash commands are disabled on this path and comment text only ever enters the session as a quoted value, but the boundary is still "whoever can comment can task the Bot". Set `docTasks: false` (boolean, per account or at the channel top level) on any account where that group is not acceptable — that is the supported way to keep an account a plain IM Bot.
2. **Every account now keeps a resident `/v1/bot/events` poller.** Card handling starts one lazily (only after the account sends a card), but doc tasks require it to be resident, so accounts that never send cards gain a permanent poller. With `eventWaitSeconds` unset the default is a ~2s short poll, i.e. roughly 25–30 requests/minute per idle account. Multi-account deployments see that multiply on the first restart after upgrading. Setting `eventWaitSeconds` (5–30) amortizes it to ~5–12 requests/minute; `docTasks: false` removes it for accounts that do not need doc tasks. Poll *errors* now back off exponentially (capped at 30s) on short polling as well as long polling, so an unhealthy or unauthorized events endpoint no longer holds the full cadence indefinitely.
3. **Split-stack deployments must set `docsApiUrl` first.** Doc task replies are POSTed to the docs domain, which falls back to `apiUrl` when unset. If the IM gateway has no `/v1/bot/docs` route, every reply 404s — a permanent failure, so it is not retried, and the fallback notice uses the same endpoint and is lost too, leaving the document edited and the comment thread empty. Previously only opted-in operators could reach this; now a split stack meets it the first time anyone `@`-mentions a Bot in a document. Failures where both the reply and the notice were lost are recorded in the per-account dead-letter store, so the case is auditable rather than invisible — but setting `docsApiUrl` (or confirming a single-origin `apiUrl`) is the first thing to check.

One deployment shape is **not** supported with doc tasks enabled: running the *same account* in more than one process. Write serialization for the doc-mention dedupe table is single-process only, and doc-task replay is not idempotent — two pollers can claim the same mention and both edit the document. This was always the case, but until now only operators who deliberately opted in could reach it. Run one process per account, or set `docTasks: false` on accounts that are replicated.

### Upgrading to OpenClaw 2026.8

2026.8 gates typed hooks for non-bundled plugins — anything installed from ClawHub, including this one — behind a config opt-in. **A plugin cannot grant it to itself**: consent deliberately lives in the operator's config, so an upgrade leaves the hooks blocked until you add this.

```json
{
  "plugins": {
    "entries": {
      "octo": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

`allowConversationAccess` is the one that must be set. For a non-bundled plugin the host requires it to be **explicitly `true`** (`allowConversationAccess === true`); left unset it blocks every typed hook this plugin registers — `before_prompt_build`, `before_agent_run`, `llm_output` and `agent_end` — and its log names this key for each of them.

There is a second key, `allowPromptInjection`, which gates prompt mutation via `before_prompt_build`. **You do not need to set it**: the host reads it as `allowPromptInjection !== false`, so an unset key already means allowed. Only set it if you want to deliberately turn prompt injection *off*.

**The failure mode is silent.** Without the opt-in the bot still connects and still replies. It simply never receives the group roster, the group MD, or its own persona, so a persona clone answers out of character and nothing in the reply hints at why. The gateway logs one line per blocked hook during startup (`typed hook "before_prompt_build" blocked because ... allowConversationAccess=true`) and this plugin logs a warning that names the consequence, but neither interrupts startup — look for them after upgrading.

Two further migrations belong to OpenClaw itself rather than to this plugin, and the gateway refuses to start until both are done: the config schema retired a number of legacy keys, and the session store moved to SQLite. Run `openclaw doctor --fix` **interactively** for these — under `--non-interactive` it reports the legacy keys without applying anything, since several of the decisions (for example `agents.ownership` on a multi-agent roster) change routing semantics and need a human. Two details worth checking by hand afterwards, because getting them wrong is quiet rather than loud:

- `mcp.servers.*.connectTimeout` / `timeout` were replaced by `connectionTimeoutMs` / `requestTimeoutMs`. The old keys were **seconds**, the new ones are **milliseconds** — a straight rename turns a 45s connect timeout into 45ms and the server never connects.
- `gateway.nodes.denyCommands` / `allowCommands` became `gateway.nodes.commands.deny` / `.allow`. If those denies were carrying a security policy, confirm the list survived the move.

A third migration is worth calling out here because its symptom points straight at this plugin: a leftover `~/.openclaw/exec-approvals.json` makes every agent run reject with `ExecApprovalsMigrationRequiredError`, and since the rejection happens *after* the message has already been routed, the bot answers `⚠️ 抱歉，处理您的消息时遇到了问题，请稍后重试。` — the plugin's own dispatch-error fallback. Nothing about it suggests exec approvals, so it reads as an Octo bug. The gateway also logs the cause during startup (`Legacy exec approvals exist at ... Run "openclaw doctor --fix" before using exec approvals`), which is easy to dismiss as a warning about a feature you do not use. `openclaw doctor --fix` migrates it; if the file only carries `version` / `socket` with empty `defaults` and `agents`, moving it aside loses nothing and the gateway rebuilds it.

Also check whether each Octo account has an agent binding. A multi-agent roster with no `default: true` marker now requires `agents.ownership: "explicit"` before the gateway will start, and `doctor` surfaces that as a decision for you rather than applying it (it changes routing semantics, so `--non-interactive` deliberately leaves it alone). Under `explicit`, every channel account needs its own binding. Without one, inbound reaches this plugin and then dies in routing with `AgentSelectionRequiredError: ... routing has no explicit owner`, so the bot receives the message and silently answers nothing:

```json
{ "agentId": "main", "match": { "channel": "octo", "accountId": "<bot_id>" }, "type": "route" }
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

### A scheme-less `user:pass@host` is reduced even when the host has no dot

`postgres://user:pw@host/db`, `user:pw@db.example.com`, a single-label host
(`user:pw@localhost`), an IPv6 literal (`user:pw@[::1]`), a password containing `/`
(`user:pa/ss@db.example.com`) and a leading slash (`/user:pass@localhost`) all lose
their userinfo. The last four were open gaps on `main`; they are what made the
tail-scan bound unsafe (the "premise" section below), so closing them is part of
this change, not deferred.

**The mechanism that makes widening the reduction safe is a single check, not the
shape of the regex.** After pass 3 picks a host and `originDomain` reduces it, the
substitution is refused unless the reduced host appears **verbatim in the host
segment** (`host.includes(...)`, not the whole match). That one check closes both
ways widening had gone wrong across review rounds:

- **`new URL()` fabricates.** It normalises `1.2.3` → `1.2.0.3`, `1.0.0` →
  `1.0.0.0`, `0x7f.1` → `127.0.0.1` — addresses absent from the input. An earlier
  attempt tried to exclude these by requiring a letter in single-label hosts, on the
  theory that dotted hosts and IPv4 "take a different branch"; review disproved it —
  the token-boundary lookahead backtracks the dotted branch to a shorter all-numeric
  host, so that branch reaches `new URL()` too. The verbatim check needs no such
  case analysis: a normalised host is not a substring of the input, so it is dropped.
- **`new URL()` lowercases the host** (WHATWG), and `AKIA…`/`AIza…` are
  case-sensitive detectors, so `a:b@AKIAIOSFODNN7EXAMPLE` had been reducing to
  `https://akiaiosfodnn7example` — past a guard that could no longer see it. The
  verbatim check is case-sensitive, so the lowercased host fails it. It compares
  against the **host segment only**: comparing against the whole match let a
  lowercase copy of the host planted in the *password*
  (`a:akiaiosfodnn7example@AKIAIOSFODNN7EXAMPLE`) satisfy the check and reopen the
  leak. Both are pinned in `LEAK_CORPUS`, and that group's substring assertion is
  case-insensitive so a lowercased secret cannot slip it.

The shape is genuinely ambiguous — `sed 's:a:b@c:g'` and `user:pw@localhost` are the
same string to a matcher — so this reduces or deletes `word:x@y` broadly in ordinary
tool output, not only the two rows first recorded: npm/maven coordinates
(`pkg:1.2.3@latest`), timestamps (`10:30@venue`), even `sed` scripts. A mixed-case
host is **deleted** rather than reduced (`time 12:00@GMT` → `time `), because the
verbatim check fails on it.

**This reaches non-ASCII text, which for a CJK-first product is the larger cost.**
The host class is `\p{L}\p{N}` (Unicode letters/digits) plus `.` and `-`, so an
IDN host (`user:pw@例子.测试`) reaches the verbatim check and is deleted — but so is
the host-shaped run in a `word:x@host` false positive written in Chinese, where the
"host" runs until the next CJK punctuation or space. `报警 level:warn@数据库连接池耗尽。建议扩容。`
renders as `报警 。建议扩容。` — the clause `数据库连接池耗尽` between `@` and the first
`。` is gone. It is bounded to that run (the class deliberately excludes CJK
punctuation and the whitespace-like code points, so it no longer swallows the whole
sentence as an earlier all-non-ASCII class did), and it never fabricates, but a
clause disappearing with no marker is a real legibility cost in the product's
primary language. All of this is safe-direction (renders less), and the breadth is a
product call — the corpus (`REWRITE_CORPUS` for the CJK sentence, `COST_CORPUS`
for a minified-JSON token that is blanked by the residual-userinfo choke point) pins the exact current
behaviour of every shape so whatever revisits it cannot change anything else
silently.

### The reduction step bounds its own input

The URL reduction runs on untrusted text — a submitted form value, a display
name, tool arguments — on synchronous paths with no error boundary, and its
passes are quadratic, so an unbounded input stalls the plugin's event loop for
every account at once. The bound is 4000 characters.

**One bound is not enough, because the pipeline is not the only work that scales
with input.** Three limits sit around it:

| limit | what it bounds | why the 4000-character bound misses it |
|---|---|---|
| `RAW_INPUT_MAX` (64 KiB) | raw tool-summary extraction, pre-reduction whitespace collapse, and any discarded-tail scan | trim/path split/URL parse and collapse all happen outside the reduction body |
| `REDUCE_BUDGET_PER_CARD` (120 000) | one display card's metered sanitization across blocks | per-call and block-count limits say nothing about the sum |
| the `exec` summary's own cut (4000) | picking a program name out of a command | it runs above the reduction pipeline |

The JWT detector is no longer a separate bounded tier. Its old regex was
quadratic on dotless `eyJ`-dense input; a run-based scanner now implements the
same match language in linear time. A deterministic 20 000-case comparison
checks random background against the old regex; another 2 304 structured cases
cross the 7/8-character segment boundary, run-local start offsets and invalid
separators. The test requires substantial positive and negative populations, so
an implementation that always returns one side cannot pass. Adversarial tests
also cover both dense starts and many short runs before a distant match.

Tool summaries apply `RAW_INPUT_MAX` before choosing a non-empty parameter, so
`trim()`, path `split()` and URL parsing never see an unbounded raw value. A tool
argument above 64 KiB omits its summary instead of trying to recover a prefix;
the tool name still renders. This is fail-closed and affects only legibility,
not tool execution.

**The per-card budget meters the reduction body and discarded-tail predicates,
not every bounded step.** The reduction body charges up to 4000 units per block.
Discarded-tail scans are metered at one unit per 128 UTF-16 code units; a tail
over 64 KiB is not scanned and immediately exhausts the budget. A 100 KB prose
block therefore costs about 4751 units, so 25 such blocks fit and the 26th
produces the marker. The initial whitespace collapse over at most 64 KiB happens
before that charge and is not separately metered. `RAW_INPUT_MAX` and the
200-block limit still bound it, but the budget is not an exact CPU-work ledger.

The budget is an availability limit, not a time guarantee. The measured worst
reachable shape is a 4000-character period-separated run (`a.a.a…`) followed by
a protocol-relative URL containing `@`: every dot creates a new word-boundary
start for the quadratic scheme-less pass, and the URL makes the evidence
preflight necessary. Warmed local measurements for 200 inputs are about **0.93
seconds** for text blocks and **1.86 seconds** for all-rich blocks (observed
0.92–0.95 / 1.85–1.89 seconds). The active reducer is about 1.78× the frozen
merge base; a `//`/`@` substring pair that pass 2 does not rewrite stays near
base at about 1.34×. The rich comparison pass and initial collapse are not
metered. The visible cost is equally important: 200 benign 4 KB blocks become
30 content blocks plus one explicit budget notice. On payload-capped profiles,
limit fitting reserves that notice and reports its own additional dropped-group
count separately. This is part of the `needs-human-review` product trade-off,
not a security regression; absolute timings are indicative, while in-process
base ratios and structural output assertions guard the mechanism.

**Discarded tails have no partial-visibility window.** If the entire tail is at
most 64 KiB, the caller's complete sensitivity predicate scans it. If it is one
code unit longer, the operation fails closed before allocating a slice. This
restores the invariant that no keyword, known prefix, JWT, or generic secret shape
used by the merge base becomes invisible merely because it sits farther from the
cut, while keeping the reduction and discarded-tail work independent of original
input size.

The distinction matters because a retained prefix may itself contain a credential
shape the downstream guard does not recognize. A distant `token` or short JWT can
be the only reason the merge base withheld that prefix. Windowing either signal
reopened a plaintext leak; the full-or-fail-closed rule removes the distance axis
instead of arguing that the prefix must already be safe.

The reduction pass still recognizes common schemeless forms — single-label,
IPv6, numeric and IDN hosts, leading `/`, and `/` inside passwords — and the
verbatim-host check prevents `new URL()` normalization from fabricating output.
Sensitivity evidence is saved before the protocol-relative pass can rewrite a
candidate: after complete scheme URLs are consumed, a preflight uses the same
scheme-less userinfo matcher and poison predicate as the final userinfo pass.
That prevents a protocol-relative JWT prefix from disappearing and exposing a
later copy of its password. The final pass still repeats the same check for
shapes formed by earlier rewrites. Pass 2 is computed first without mutating the
preflight input; the extra scan runs only when pass 2 actually changed the string
and the original contained `@`. Both scans stay inside the 4000-character
reduction bound. The generated performance corpus includes the period-separated
shape alone, with inert `//`/`@` substrings, and with a real protocol-relative
rewrite containing `@`.
After those passes, one default-deny choke point withholds any remaining
scheme-less whitespace token whose first `:` precedes its last `@`. That closes
non-ASCII and punctuation-terminated usernames, IPv6 zone IDs and empty hosts
without adding another host or username character class.

This is intentionally broad. Regex-like email searches, minified JSON containing
an address, package coordinates, timestamps and some prose can share the same
`name:…@` shape and are withheld too. `COST_CORPUS` records representative base
outputs beside the new empty result; the generated parity space pins the exact
over-hide counts. Deciding whether that legibility cost is acceptable is the
remaining product-owner review.

Two residual disclosure classes are explicit rather than hidden in test-only
notes:

- One `read`-summary truncation-alignment comparison remains. Base already emits
  at least the first 12 characters of the external secret and ends in `…`; head's
  shorter, correct reduction lets the full external copy fit in the 64-character
  window. The generated differential guard admits exactly this one
  mechanism-matched case. A future read-sink external-copy guard is required to
  remove it without reverting the safer host reduction.
- Passes 1, 2 and 4 can delete a keyword that caused the whole line to be
  withheld, then expose an external low-entropy copy. Those passes are identical
  to the merge base, so this is base-identical rather than a regression from this
  branch; it remains a separate sanitizer-hardening follow-up.

Relaxing that pass is where this branch has historically broken things. How the
failure modes are closed — by the verbatim-host check, not by the shape of the
regex — is described under "[A scheme-less `user:pass@host`](#a-scheme-less-userpasshost-is-reduced-even-when-the-host-has-no-dot)"
above, together with the two attempts that traded one defect for another (a
mid-token cut that fabricated `https://sha256abcd`, and a "single-label must contain
a letter" rule that review disproved because the dotted branch backtracks into
`new URL()` too). The sentinels for both — `nginx:1.21@sha256:1234abcd`, `3:4@2/x`,
`a:b@1.2.3`, `scope:name@1.0.0`, `a:b@0x7f.1`, and the two `AKIA` case-folding rows —
stay in the corpus.

The password segment in the reducing regex remains capped at 256 characters; an
uncapped `/`-accepting pattern becomes quadratic. `hasOverlongUserinfo` provides a
linear fail-closed check for the over-cap form, while the residual-userinfo choke
point covers forms whose username or host does not match that check. The
interactive echo path also applies the same sensitivity predicate after reduction,
so a reduce-only caller cannot bypass the guard.

The JWT scanner is the sole implementation of that rule in production code; the
old regex exists only as a test oracle. It splits the input into base64url runs and
keeps the last two runs plus dot adjacency, so each character is read a constant
number of times. This is a replacement of the quadratic authority, not a second
live detector that can drift from it.

`RAW_INPUT_MAX` **is not output-neutral**, and an earlier revision of this section
claimed it was. That claim then justified truncating at exactly 64 KiB with no
regard for token boundaries — which cut through a `user:pass@host` and rendered
the password in full, the very defect the whitespace rule exists to prevent. The
truncation now lands on whitespace like the reduction's own does. Where the
collapse ratio is high, 64 KiB of raw text may collapse to only a few thousand
characters and later content is dropped. The complete discarded part is inspected
only when it is at most another 64 KiB; a longer remainder causes an immediate
fail-closed result. In display cards that also exhausts the per-card budget, so one
very large block is replaced by the explicit budget notice rather than a partial
prefix.

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

Both the 64 KiB collapse and the 4000-unit reduction cut call the same
`cutOnWhitespace` and `tailIsSensitive` implementations. The `exec` program-name
path reuses the cut rule as well. There is no second scan-window algorithm: an
in-budget tail is passed whole, and an over-budget tail fails closed. This removes
the recurring class where one copy of a boundary or detector silently diverged
from another.

That predicate is passed in rather than fixed, because there is no single right
answer: `main`'s own behaviour forks by strategy, withholding a trailing long hex
run under `grep` and rendering it under `read`. Hard-coding the strict form blanks
ordinary text ending in a git SHA; hard-coding the lenient form misses a
high-entropy tail. Taking the caller's predicate makes this guard *identical* to
the one downstream by construction, which is the only version that cannot drift.
It checks only the discarded segment: checking the whole string blanks content
the reduction exists to make safe, such as a webhook URL followed by a page of
prose.

That guard is deliberately **stricter** than the downstream one because it runs
before reduction and reads raw text. An ordinary documentation link in an
in-budget discarded tail can trip the entropy check even though reduction would
have made it safe. A tail too large to inspect is withheld wholesale. Both are
safe-direction availability costs and are pinned in `COST_CORPUS`.

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

- **A display-card text block** has no output-length cap of its own, so it relies
  on the shared collapse/reduction bounds. A tail beyond the scan allowance
  exhausts the card budget and produces the explicit budget marker.
- **A copy-to-clipboard block** over the bound is refused rather than truncated,
  with a message that says *characters* — its other limit, 4 KiB, is a byte limit
  and gets its own message. A reader pastes that content somewhere, so a partial
  value is worse than an honest refusal.
- **The status card that echoes an interactive submission** is the lowest-trust
  boundary of the three. It uses the default strict predicate during reduction
  and checks the reduced value again, returning `[redacted]` when either path
  withholds the input.

Those three are where the bound is *visible*, not where it *acts*: it lives inside
`reduceUrlsInText`, so all eleven callers change at long input. Three change in a way
"long text gets truncated" does not predict — a rich text block loses per-segment
styling (the safer output, and it closes a `card ⊋ plain` divergence `main` has),
a short authored title emptied by poison/default-deny receives the neutral reason
“withheld by sanitization”, and a debug value and a reasoning step both yield `""`
rather than a truncation. Over-long nonblank titles still report the length or a
sensitive discarded tail specifically. An all-whitespace value beyond 4000
characters cannot be proven blank inside the bound, so authored titles use the
neutral withheld reason and action-status display names render `[redacted]`.

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
