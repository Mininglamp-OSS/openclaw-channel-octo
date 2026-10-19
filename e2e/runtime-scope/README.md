# Runtime scope probes

These test-only fixtures use synthetic loopback Octo and model peers. They never
need a real Octo account, model API key, recipient or configured Gateway. They are
not shipped in the plugin package. Run the Gateway probe only in a disposable
container/environment with a fresh host installation and the built plugin.
Honor that host's Node engine constraint (10.5 requires Node 24.16+ in the 24.x
line, or 26.1+). Both the plugin SDK import and the Gateway must resolve the same
exact host installation; do not mix a newer CLI with an older SDK dependency.

The ordinary SDK contract probe needs only the existing dev dependencies:

```sh
node --test scripts/verify-runtime-store.mjs
```

It tests actual transpiled production modules, logs the detected storage mode,
and fails rather than skipping the known managed SDK releases if their private
test scope cannot be located. CI also type-checks `src/runtime.ts` against every
selected official SDK. Run this command from any working directory using the
script's absolute path if needed.

With a full instance-aware host installation in an isolated test checkout:

```sh
npm run build
OCTO_RUNTIME_HOST_ROOT=/path/to/isolated/openclaw node e2e/runtime-scope/production-path.mjs
```

This uses the actual host `PluginInstance`, bundled-entry registration, registered
channel view, `startAccount`, WuKongIM DH/AES handshake and encrypted WebSocket
inbound, actual inbound handler and actual HTTP final send. Only the Agent
runtime dispatcher/session services are stubbed. A candidate instance registers
and retires before the live account receives its message. The probe asserts live
runtime identity and host admission at Agent handoff. It is not a full Gateway
startup, reload or real message-service test.

Inside a disposable container/environment with that full host and built plugin:

```sh
OCTO_RUNTIME_HOST_ROOT=/path/to/isolated/openclaw node e2e/runtime-scope/gateway.mjs
```

This starts a new Gateway with temporary state and synthetic credentials, then
observes registration, the real encrypted WebSocket message, the real Agent
pipeline using a deterministic local OpenAI-compatible model response, and one
HTTP final reply. Only the remote Octo service and model provider are synthetic;
there is no real private-chat or reload acceptance claim. The child Gateway and
state are cleaned up. Set `OCTO_RUNTIME_KEEP_EVIDENCE=1` to retain its synthetic
state and Gateway log for diagnosis.

The `npm run test:e2e:openclaw` card harness uses a WuKongIM WebSocket
peer through the account's supported `wsUrl` override. It never imports Octo's
runtime/inbound or supplies an arbitrary route override. The host computes the
normal DM route; `/new` and `/reasoning stream` start each scenario. All five
original cases remain enabled: short yield/follow-up, 75-second yield retention,
filesystem tools, message-tool delivery, and display-card delivery. The runner
uses Vitest `--bail=1` so a failed yield does not overlap a later conversation.
This is failure reporting, not a passing full-lifecycle acceptance claim.

Run only in an explicitly selected, idle, disposable Linux container with `node`,
`openclaw`, `flock`, a synthetic Octo account configuration in
`OCTO_E2E_STATE_ROOT` (default `/root/.openclaw-dev`), and installed plugin
dependencies under that profile's `extensions/octo/node_modules`. Never point
this harness at a user installation, running Gateway or production recipient.
`card-service.mjs` supplies the synthetic remote HTTP service on loopback port
19124; it does not claim real Octo server/client rendering acceptance.

```sh
OCTO_E2E_CONTAINER=my-disposable-container \
OCTO_E2E_TARGET_UID=user_card_e2e_00000000000000000000 \
npm run test:e2e:openclaw
```

Before building or preparing configuration, the runner acquires the container's
exclusive persistent lease under `/var/lib/octo-host-e2e`. Controller operations
use `flock`; another runner fails before setup. Every run gets a UUID directory
with a private profile, workspace, session database, extension copy, model port,
request/receipt ledger and Gateway log. The source profile/configuration is
read only; an existing Gateway causes refusal and is never stopped. Source tool
restrictions and Octo conversation-hook permissions are preserved. Unsupported
remote/sandbox tool policies cause refusal instead of a policy override.

SIGINT/SIGTERM and ordinary failures dispose only the exact owned private
Gateway and descendants, verified by run/profile environment stamps and process
start identity. **SIGKILL cannot execute a signal handler.** Its durable lease
survives; subsequent runs refuse automatic takeover. A separate host-side child
supervisor observes runner reparenting and stops its build/Vitest process group,
including grandchildren, so an orphan test cannot continue injecting requests. After confirming the runner
has exited, recover explicitly from the same machine:

```sh
OCTO_E2E_CONTAINER=my-disposable-container \
node scripts/run-openclaw-card-e2e.mjs --recover EXACT_RUN_UUID
```

Recovery verifies the lease token, container identity and dead local owner PID
with process birth time. It refuses a live owner or another machine's owner.
It removes only that private profile and snapshot; it retains non-secret run
metadata and diagnostic ledgers/logs. Container restart preserves the ledger;
deleting the container filesystem does not. The original profile needs no
restoration, including after SIGKILL. Keep the task container until evidence is
collected. `infra-recovery.mjs` exercises real concurrent-run refusal, live/wrong
recovery refusal, SIGTERM cleanup, SIGKILL after a real Gateway starts, exact
recovery, source byte preservation and unrelated-process survival in a dedicated
synthetic container using the same two environment variables above.

The synthetic HTTP fixture also accepts `OCTO_CARD_E2E_FAULT_FILE`, a local
mode-file path supplied only to that test service. Writing
`foreign-completed-own-absent` refuses the owned reasoning-card creation while
inserting a newer completed foreign card for the same target: the selected
filesystem test must fail with `cards: []`. `foreign-completed-noise` keeps the
owned creation and injects the same foreign success: the three delivery cases
must pass using only owned IDs. Emptying the mode file restores ordinary fixture
behavior. The service logs the exact foreign/owned IDs for audit.

Each injected input is recorded with lease/request UUID, actual encrypted WS
message ID, matching ACK, account owner digest and host-derived session key.
The `before_agent_run` hook binds its exact nonce to the real host run ID.
Reasoning cards must carry the production session/run reasoning ID and an actual
HTTP create receipt; display cards also require the real tool's returned card ID.
Readback uses that exact card ID and accepted edits from the same owner. Target
and timestamps cannot supply a successful card. Missing/ambiguous bindings fail
closed. `src/e2e-evidence.test.ts` covers foreign completed cards masking own
errors/absence, wrong owner/session/run, rejected ACK and mismatched tool/edit IDs.
The nonce is test correlation evidence, never a production authorization signal.

Current 2026.10.5 acceptance: the migrated filesystem, message-tool and display-card
cases pass against the actual Gateway with a synthetic remote service. The short
yield case still exposes a production compatibility failure: the host's automatic
`continuationStatus` waiting reply completes the progress card before its child
settles. Static inspection also found a difference between the newer provenance-stamped
completion format and the protected text format recognized by the current card
continuation code; that second risk is not independently proven as a failure.
Both yield assertions remain enabled and unchanged; this is not full lifecycle
acceptance. Fixing those production boundaries requires a separate scoped change,
not a global runtime fallback, fabricated completion or relaxed ownership check.
