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

The older `npm run test:e2e:openclaw` card-lifecycle harness requires an existing
container plus real Octo receiver/service and restarts that container's Gateway.
Its bridge directly imports inbound from a different plugin: that cannot claim
Octo invocation scope on a managed host. The invalid bridge setter is removed,
and direct injection now fails with an explicit scope diagnostic instead of
seeding the bridge's slot. Use the WebSocket Gateway fixture above to verify the
managed runtime path. It does not replace the older harness's separate card,
subagent/yield or real-service acceptance coverage.
