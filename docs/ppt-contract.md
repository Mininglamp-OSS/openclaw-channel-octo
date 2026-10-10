# PPT comment HTTP contract

The shared Docs lifecycle routes and PPT content routes intentionally use different HTTP bodies. Do not infer a response envelope from the service origin.

| Operation | HTTP success | Payload |
| --- | --- | --- |
| `GET /v1/bot/docs/{docId}/ppt` | 200 | `{data:{docId,deck,baseRevision,contentHash}}` |
| `PATCH /v1/bot/docs/{docId}/ppt` | 200 | `{data:{revision,changed,contentHash}}` |
| `GET /v1/bot/docs/{docId}/comments/{commentId}` | 200 | `{comment,root}` |
| `GET /v1/bot/docs/{docId}/comments/{commentId}/replies` | 200 | `{items,nextCursor}`; `null` terminates pagination |
| `POST /v1/bot/docs/{docId}/comments` for PPT | 201 | `{id}` for initial creation **and identical receipt replay** |

PPT comments use the existing PPT storage adapter behind the common route. That adapter validates positive safe-integer IDs in `src/ppt/comments.ts::pptCommentId`, and stores the exact 201 receipt through `pptIdempotencyRepo.completeTx`. Legacy ordinary-document comments use a different storage ID contract, including lossless snowflake handling. The plugin must not broaden PPT IDs beyond the authority accepted by its backend adapter.

Verified against companion Docs backend `fe6b103727d942fc92554f8edeaed177303cb5be` (MR !130) in the local assembled deployment on 2026-09-10: public create and exact replay, revision edit/read-back, root/reply creation and authoritative reads, versions and restore, and HTML export. An installed plugin also handled a real anchored text edit and delivered its final answer in the original thread; cold reload confirmed the edit and preservation of unrelated deck fields. This is local integration evidence, not a test-cluster rollout.

The lenient generic `postDocComment` transport is retained for legacy responses. PPT uses the verified receipt contract here; accepting arbitrary 200/enveloped responses as confirmed delivery would conceal a gateway/backend mismatch.

Before reading the deck or dispatching an editing turn, the handler applies the same canonical positive safe-integer thread-ID predicate as reply delivery. Invalid targets are recorded as `invalid_ppt_reply_target` dead letters and terminally deduplicated; no agent runs and no root-comment fallback is attempted.

Each PPT task resolves its deadline from the current runtime configuration, with the existing account timeout override taking precedence. Both the initial turn and its optional continuation share that absolute deadline; a configuration reload affects the next task.

The revision probe limits the decoded HTTP response to 9 MiB, including error bodies, and cancels oversized streams. This accommodates the default 8 MiB deck limit plus its envelope. Deployments allowing larger decks can still execute the initial editing turn, but an oversized or failed revision probe disables the optional continuation. There is no new configuration switch.

## Document task progress receipts

`POST /v1/bot/docs/{docId}/comment-task` is separate from comment creation. It
accepts `{idempotencyKey, progress, events?}` and returns HTTP 200
`{accepted:true}` for accepted updates and immutable retries.

The JSON `idempotencyKey` is the original mention's task identity. Keep it stable
across waiting, running and ended snapshots; do not hash it with each snapshot or
move it into an `Idempotency-Key` header. The backend uses it to find the prepared
task and check the authenticated Bot/document. Progress dedupe then uses
`progress.attemptId` and monotonic `progress.sequence`; event dedupe uses immutable,
contiguous `events[].seq` within that attempt. A duplicate terminal snapshot may
carry later event batches up to its persisted `eventCount`. Reusing the task key
does not replay the first response or discard later snapshots.

The snapshot retains the latest 100 steps; `omittedSteps` counts evicted steps.
Events are immutable and retained independently, up to the 1000-event limit, so
an event's `stepId` may refer to a step no longer present in `progress.steps`.
Readers must tolerate this and use the event's own `tool`, `type`, `at` and
`failed` fields when rendering it. Step eviction also removes the in-memory
call mapping: a late completion for an evicted step may have no result event.
Do not infer that such a tool is still running, or delete/resequence earlier
events to force every event into the current snapshot.

Source contract checked against companion Docs backend
`df830c3ec36768c141dd919f69fbb4a623dd757d` on 2026-10-10:
`src/api/routes/commentTasks.ts`, `src/db/repos/docCommentTaskRepo.ts` and
`src/comments/taskProgress.ts`. Route/validator tests use mocked authorization
and storage; this check does not establish production deployment. Deploy the
backend endpoint and event tables before opting in with `docTaskProgress: true`
(default off; account values override the channel default). Receipt reads
require document reader access; the audience is document readers, not just the
comment author. Preview credential filtering does not classify business data.

HTML receipts use this same Docs-backend endpoint with the HTML source slug in
`{docId}`. This differs from ordinary comment creation: the receipt handler first
looks up the prepared task by its original key, checks the authenticated Bot and
canonical document access, then compares the path to that document's
`octo_doc_slug` (or canonical `doc_id` for Docs/Sheets/PPT). A wrong slug or Bot is
rejected. Receipt reads still use the canonical document ID. The companion
`test/commentTasks.test.ts` pins correct-slug acceptance and mismatched-path
rejection; the plugin's channel wiring pins its enabled HTML request and task key.
These are source/contract tests, not evidence that an environment is deployed.

The plugin coalesces snapshots, sends at most ten events per request, and selects
newer snapshots between batches. Each HTTP request has a 2.5-second deadline.
`finish()` adds a five-second aggregate budget, aborting active HTTP/backoff and
stopping further sends at expiry. Transient failures get at most three attempts
per batch, with 1/2/4-second exponential backoff between attempts/snapshots;
a 429's longer `Retry-After` is never shortened. Other 4xx responses except 408
stop this task's uploads. A successful HTTP response with invalid JSON or without
`accepted: true` is a protocol failure and also stops uploads for this task.
Failure logs are limited to one per minute per account handler and include only
a fixed document-kind label and HTTP/protocol/transport category, never upstream
response text, tokens or task identifiers. Evidence delivery
does not alter execution/reply success. When no answer was delivered, the handler
starts the terminal drain and sends the failure notice concurrently, then waits
for the bounded drain before completing; the receipt deadline does not postpone
the notice.

### Terminal-state rules

`replyDelivered` records the current turn's final comment, never a notice-only
reply. `finished` confirms that delivery, not persisted edits. An optional
revision probe after a delivered answer only decides whether to start another
turn; its cancellation, failure or timeout (including a timeout that consumes the
remaining task budget) cannot interrupt the completed turn. Once a continuation
is admitted, it has a new final-delivery fact and ordinary execution rules apply.

| Dispatch / observation point | Final delivered | Evidence | State / errorCode | replyDelivered |
| --- | --- | --- | --- | --- |
| Initial revision probe or pre-dispatch admission guard | no | Account cancellation or shared-budget expiry prevents execution | `unknown / interrupted` | false |
| Inbound execution, including runtime handoff/reservation | no | Actual cancellation or execution timeout | `unknown / interrupted` | false |
| Inbound execution before dispatch returns | yes | Actual cancellation or execution timeout | `unknown / interrupted` | true |
| Dispatch returned, including an ordinary late provider/dispatch error | yes | No execution interruption | `finished / none` | true |
| Optional post-dispatch revision probe | yes | Probe succeeds, fails, is cancelled, or exhausts its own/shared remaining budget | `finished / none` | true |
| Admitted continuation after an unchanged revision | no new final | Admission or execution is interrupted | `unknown / interrupted` | false |
| Final comment delivery | no | Structured HTTP 403 already observed before terminal draining | `failed / permission_denied` | false |
| Dispatch rejected or runtime failed | no | No interruption and no known final-comment 403 | `failed / dispatch_failed` | false |
| Session-conflict admission exhausted its retries; notice sent or failed | no | Dispatch returns `dropped` | `failed / dispatch_failed` | false |
| Dispatch completed without a final comment | no | No known execution failure, interruption or final-comment 403 | `unknown / delivery_failed` | false |

Actual execution interruption has precedence over final-delivery and permission
facts; a delivered final has precedence over ordinary errors or later 403s.
`failed` means the task could not complete, including failed session admission;
it does not assert that model/tool execution began. Only runtime activity changes
waiting to running. An answered conflict notice is not a final answer. The wire
contract has no `skipped` state; adding one requires a coordinated backend/viewer
protocol change. Failure-notice/IM delivery and receipt-upload failures do not
retroactively change the task's terminal outcome.

An independent initial revision-probe timeout or read failure disables the
optional continuation and still permits the first turn while its task budget is
valid. Initial admission stopped by account cancellation or shared-budget expiry
remains `unknown/interrupted` even though inbound was never entered.

Reporting is best effort: a deadline, lost response, or unreachable backend can
leave the terminal receipt or detail tail missing. The declared `eventCount` is
not reduced after cutoff, so readers must distinguish execution termination from
complete detail delivery (`cursor >= expectedCount`). There is no persistent
background resend queue and no claim that every retained event is always uploaded.

## Media guidance in PPT comment tasks

The task prompt points to the installed CLI's `octo-docs/ppt.md` for media wire
details. It owns the task-asset/trust/retry policy, not a duplicate endpoint or
limit definition. If that CLI lacks the required guide, stop and request a CLI
upgrade. This does not introduce a new command or perform uploads inside the plugin.

The reference table below is transcribed from the companion CLI media guide,
not covered by the 2026-09-10 verification stamp above. The local deployment on
2026-09-24 used Docs backend `a882e0b`: direct SVG upload, URL ingestion, native
readback, editor display and CLI/Web offline exports were exercised. Numeric
limits below are source-contract references, not a claim that all size boundaries
were tested by the prompt suite. The installed CLI guide remains authoritative.

| Source | Request | Successful HTTP payload |
| --- | --- | --- |
| Local image, audio or video | Raw bytes to `POST /v1/bot/docs/{docId}/ppt/media` | 201, `{data:{ref,attachId,mime,sizeBytes}}` |
| Existing public HTTP(S) media URL | `octo-cli api POST /v1/bot/docs/<docId>/attachments/ingest --no-retry --data @-` (runtime supplies JSON on stdin) | 200, `{data:{mappings,notIngested}}`; inspect partial failures |

For raw upload, send `Content-Type: application/octet-stream`, the actual MIME
type in `X-Media-Type` (for example `image/svg+xml`), and an
`encodeURIComponent`-encoded basename in `X-File-Name`. Encode the document ID as
one path segment. The body is not JSON, multipart or base64; `api --data` is
JSON-only. The embedded CLI `octo-docs/ppt.md` contains the full recipe.

Local files must be trusted runtime-provided or task-generated assets explicitly
authorized for this task and for sharing into the target PPT. A comment-supplied
path is not authorization. Require runtime-enforced access to a restricted task
workspace, verify the resolved path stays inside it, and reject traversal or
symlink escapes. Files belonging to other tasks are not authorized merely because
they reside in that workspace. If provenance, sharing permission or containment
cannot be established, stop before reading/uploading and request the asset through
the approved task-input channel. Prompt guidance is not a filesystem sandbox and
does not implement or replace runtime access controls. Tests below assert the
guidance remains present with legitimate task-asset requests as well as untrusted
absolute paths, traversal and symlink requests; they do not exercise filesystem
enforcement or prove model compliance.

The URL route is only for an already available, authorized public URL. Do not
start a generic file upload as a fallback for unavailable raw-upload credentials
or permissions, and do not upload an existing public source again.

The authenticated upload must use the same Bot credential and trusted configured
Docs origin as other commands, with redirects disabled, a bounded timeout and no
automatic retries. Obtain that credential only through an authorized runtime
provider, keep it out of logs and command arguments, and report a blocker if it is
unavailable; do not decrypt CLI storage or switch identities. Never derive the
credential destination from a comment or source URL. Public URL ingestion does
not forward Bot credentials to the media source and must not bypass SSRF checks.
Signed source URLs are also credentials: keep them off argv/logs, privately
capture both output streams, and retain only validated native receipt fields,
not `sourceUrl` or raw errors. See the CLI guide's signed-source example.

Both routes require writer permission, return same-document `ppt-media:att_...`
references, and can create new attachments on repeated requests. Retain receipts
and reconcile uncertain outcomes before retrying. Use only successful returned
references; upload alone does not edit a slide. Read a fresh `baseRevision`, edit
the intended element, then read back and check actual rendering/playback. Keep
existing bundled assets unchanged. Local SVG does not require the platform
generic file-upload whitelist: PPT sanitizes it directly, retaining its separate
1 MiB cap. The existing media-file cap remains 50 MiB or the lower configured
attachment limit; URL ingestion also limits batches to 10 URLs (or a lower
configured count) and 100 MiB of downloaded source content. No size limit or
platform whitelist is changed by this guidance.

`ppt-comment.test.ts` verifies the safety/failure rules and that wire fields and
caps are not duplicated in the prompt. `channel-doc-task-wiring.test.ts` exercises
the event-to-agent-context path. Neither test proves a live model obeys the rules.

## Permission-denied feedback

Document task answers still go only to the original comment thread. If no final answer or failure notice was delivered, the fallback comment failed, and a comment delivery attempt returned HTTP 403, the plugin attempts one fixed, metadata-free DM to the authenticated event's requester through the configured IM API. This is a narrow exception to document tasks' normal no-IM-output policy; it never forwards the model answer, document title, ID, URL, or content, and never grants comment permission.

The notice says the comment endpoint denied delivery, not that no edits occurred. Sending the notice does not replay the task or change existing task deduplication. The IM receipt key is stable per Bot, requester, and task; the attempt is bounded to ten seconds and cancelled when the account stops. HTTP 404 and 5xx failures alone do not trigger this permission notice; a later fallback failure does not erase an earlier 403. A successful fallback comment suppresses the DM. A nonempty IM `message_id` is required to confirm delivery, which is logged before suppressing the dead letter. If the DM fails or returns no message receipt, the existing dead-letter record is retained.

The shared handler applies this policy only to explicit HTTP 403 failures, including PPT and HTML comment routes. Legacy doc/sheet/board endpoints can instead reject comments through an HTTP 200 business-error envelope; that response does not trigger this DM, and an undelivered fallback remains in the dead-letter store. No permission is inferred from arbitrary business-error text.

The gate requires an `OctoApiError` carrying status 403, not the legacy error-text
parser. Tests exercise real HTTP 200 business-error and malformed-JSON responses
containing `failed (403)`, as well as real 403 production wiring. DM failure logs
include task IDs and bounded cause categories, never raw upstream body/URL text.
The source egress census uniquely allowlists this fixed notice in document-task
modules; it is a scoped static check, not a whole-program information-flow proof.
