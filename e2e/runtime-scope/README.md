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

The existing `npm run test:e2e:openclaw` card-lifecycle harness now uses a
WuKongIM WebSocket peer through the account's supported `wsUrl` override. It
never imports Octo's runtime/inbound or supplies an arbitrary route override.
The host computes the normal DM route; `/new` and `/reasoning stream` start each
scenario. Original card, subagent/yield, follow-up, filesystem, message-tool and
display-card assertions remain enabled. Existing remote Octo HTTP sends/edits
are retained when using a configured real test service/recipient. Run it only
in a disposable test container/profile: it restarts that Gateway and resets the
test conversation. Configuration is restored and the companion removed after
success or failure. `card-service.mjs` supplies an optional synthetic remote
HTTP service for isolated acceptance without a real recipient; it does not
claim real Octo server or client rendering acceptance.

Current 2026.10.5 acceptance: the migrated filesystem, message-tool and display-card
cases pass against the actual Gateway with a synthetic remote service. The short
yield case still exposes a production compatibility failure: the host's automatic
`continuationStatus` waiting reply completes the progress card before its child
settles. The newer provenance-stamped subagent completion format also differs
from the protected text format the current card continuation code recognizes.
Both yield assertions remain enabled and unchanged; this is not full lifecycle
acceptance. Fixing those production boundaries requires a separate scoped change,
not a global runtime fallback, fabricated completion or relaxed ownership check.
