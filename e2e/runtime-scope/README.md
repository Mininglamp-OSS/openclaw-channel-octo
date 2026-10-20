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

Policy preflight validates the source snapshot and generated profile with the
**actual installed host validator**, and verifies that the CLI binary and plugin
SDK resolve to the same installation. It runs before build/Gateway startup.
Each schema call imports the actual validator in a fresh subprocess whose
process-level home, state and config are private **before** any host import;
passing a local validator `env` alone is insufficient. The subprocess state is
removed after the call. Tests follow the installed schema's legacy-layout
contract: an unsupported `agents.list` must be rejected, not silently migrated.
The root `tools` and canonical main-agent `tools` objects retain their separate
allow/deny/alsoAllow/profile, sender, exec, elevated and filesystem settings;
they are never flattened into a guessed merge. Supported defaults including
`elevatedDefault`, sandbox-off settings, skills and subagent limits survive.
Workspace/cwd/repository paths are rebased into the private workspace.

The fixture accepts a fresh config-only synthetic source with one main agent.
It refuses unsupported/unknown fields rather than discarding potential policy:
extra agents or root security/session/routing configuration, another enabled
plugin context, active sandbox/remote exec, provider-specific tool policy,
model-scoped patch policy, or persisted execution-policy/state files require a
separately verified fixture. Replacing the model provider cannot preserve those
model-specific policies by blindly copying their old selectors. A missing host
validator, mismatched CLI/SDK or invalid source also causes refusal before a
runnable private config exists. In particular, **`agents.defaults.tools` is not
supported by the verified 8.1/10.5 schema**; it is rejected, not silently moved or
copied to a field the host ignores. Tool defaults live under root `tools`, with
main-agent policy under canonical `agents.entries.main.tools`.

```sh
node --test scripts/verify-e2e-policy.mjs
# Run only against a disposable exact host installation:
OCTO_E2E_POLICY_HOST_ROOT=/path/to/openclaw node --test scripts/verify-e2e-policy.mjs
```

This offline contract probe executes the installed host's actual schema,
ordered policy pipeline, sender policy, exec defaults, elevated gate and
filesystem policy. It compares source/private permissions and exercises refusal
negatives. The elevated test adds only a temporary export to a sibling copy of
the host module; original SDK bytes and production code stay unchanged. CI runs
it against locked 8.1 and the exact 10.5 archive under a supported Node version.
The plugin runtime's older-host compatibility matrix is separate from these
verified harness-policy contracts. A source deny may cause the tool E2E case to
fail; the harness never removes a deny to make its workflow pass.

SIGINT/SIGTERM and ordinary failures dispose only the exact owned private
Gateway and descendants, verified by run/profile environment stamps and process
start identity. **SIGKILL cannot execute a signal handler.** Its durable lease
survives; subsequent runs refuse automatic takeover. A separate host-side child
supervisor observes runner reparenting and stops its build/Vitest process group,
including grandchildren, so an orphan test cannot continue injecting requests.
Worker exit also triggers bounded TERM/KILL cleanup of surviving group members,
while retaining the worker's original exit code. After confirming the runner
has exited, recover explicitly from the same machine:

```sh
OCTO_E2E_CONTAINER=my-disposable-container \
node scripts/run-openclaw-card-e2e.mjs --recover EXACT_RUN_UUID
```

Recovery verifies the lease token and container identity, requires a valid
recorded local owner PID/birth and permits cleanup only when the OS confirms
that PID is absent (`ESRCH`); that positive absence check does not require `ps`.
An empty/invalid recorded birth refuses recovery. For a present PID, missing or
broken `ps`, empty/malformed output or other inspection failure refuses recovery;
permission errors checking PID existence also refuse it. A live owner refuses
it; an existing PID with a different birth is reported separately and retained
for manual inspection. Initial acquisition requires a valid nonempty birth.
Another machine's owner cannot be recovered automatically.
After process teardown, completed disposal removes the entire exclusive-created
UUID directory: private profile, source snapshot, requests/results, Gateway log
and metadata. This applies after both passing and ordinary failing tests; there
is **zero automatic artifact retention** after completed cleanup. Only then is
the lease released. Startup failures print a bounded log tail, and Vitest failure
evidence remains in runner output; redirect stdout/stderr to a chosen file if
needed.

Failed/interrupted cleanup retains the lease and remaining directory for exact
recovery. A durable `removing` phase allows retries after partial deletion or
failure to release the lease, even if metadata/the directory is already gone.
Repeated completed cleanup while idle is a no-op. Directory device/inode/birth
identity and metadata/lease ownership are checked before deletion; a replacement
already present at verification, or a symlink directory, is refused. Lease and
metadata reads use `O_NOFOLLOW`, require a regular file and read the same opened
descriptor. Ownership is compared by immutable record fields, not a permanent
inode/hard-link relationship: `prepare` and `mark` atomically replace both files.
Existing UUID directories are never claimed,
and unrelated/unleased or legacy artifacts are never swept. Legacy leases
without creation identity require manual inspection rather than automatic
whole-directory deletion. Container restart preserves the ledger; deleting the
container filesystem does not. The original source profile needs no restoration.

The entire controller operation, including asynchronous process teardown and
directory verification/removal, holds `operations.lock` through `flock`. All
lifecycle writers of the lease and `runs/<UUID>` directory entries must use that
lock. Gateway/test artifact writers operate inside that run and are stopped
before removal. New control roots and run
directories use mode `0700`; an existing control root is not automatically
chmodded and must remain writable only by the dedicated container owner. This
is a cooperating-runner safety contract in an idle disposable container. It is
not a filesystem security boundary against root or another same-UID process
that deliberately bypasses the lock: that writer can replace a verified path
before path-based recursive removal. Do not share the container/control root
with untrusted workloads. No inode check is claimed to close that race.

`infra-recovery.mjs` exercises real concurrent-run refusal, live/wrong
recovery refusal, SIGTERM cleanup, SIGKILL after a real Gateway starts, exact
recovery, config/fixed-sentinel byte preservation and unrelated-process survival in a dedicated
synthetic container using the same two environment variables above.
Its source-preservation checks use `OCTO_E2E_STATE_ROOT` (or the same default
`/root/.openclaw-dev` as the runner). Before launching any runner, it requires
both `openclaw.json` and `original-workspace/sentinel` under that selected root;
a missing file fails the probe rather than falling back to another profile.
This digest covers exactly those two files, **not the configured source
workspace or its tree**. Changes to other files, including files under a
different `agents.defaults.workspace`, are outside this check and can leave the
digest unchanged. Passing it must not be reported as whole-workspace integrity.

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
Synthetic server errors remain observable after readiness: the bridge records
them in the owned ledger and subsequent evidence/requests fail. Repeated error
events do not become uncaught exceptions. The production-path probe attempts
all teardown steps even if account shutdown or another cleanup step rejects;
the original failure is preserved.

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
