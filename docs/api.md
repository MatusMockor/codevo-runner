# Task, execution and attachment API (protocol version 1)

Creating a task stores a draft; it never starts execution by itself. With execution
enabled, a separate start command durably queues the draft against a registered
server project. The default deployment keeps execution disabled.

Every route below requires `Authorization: Bearer <token>`. The only public route
is `GET /healthz`. Requests with an Origin header are rejected. Paths are exact;
unsupported query parameters and trailing-slash aliases are not accepted.

| Request | Response |
| --- | --- |
| `GET /v1/runner` | Identity and advertised capabilities |
| `POST /v1/tasks` | `{ task, created }`, 201 for new or 200 for identical retry |
| `GET /v1/tasks?after=0` | `{ items, nextCursor }` in ascending creation sequence |
| `GET /v1/tasks/:id` | Task |
| `POST /v1/tasks/:id/cancel` | Cancel task; no request body |
| `GET /v1/projects` | `{ items: [{ id, name }] }`; execution deployment only |
| `POST /v1/projects/clone` | Clone job, HTTP 202; body `{ idempotencyKey, url, name, branch?, parentPath? }` |
| `GET /v1/project-clones/:id` | Clone job |
| `POST /v1/project-clones/:id/cancel` | Cancel clone job; no request body |
| `POST /v1/tasks/:id/start` | Task, HTTP 202; body `{ "projectId": "my-app", "base"?: StartBase }` (see [Git sync](#git-sync)) |
| `GET /v1/tasks/:id/resume` | Continuation eligibility `{ available, reason }` |
| `POST /v1/tasks/:id/continue` | `{ task, created }`, 202 for new or 200 for identical retry |
| `GET /v1/tasks/:id/diff` | `{ patch, truncated, untrackedFiles }` |
| `GET /v1/tasks/:id/files` | Bounded changed-file list `{ files, truncated }` |
| `POST /v1/tasks/:id/file-diff` | Original and current text for one changed relative path |
| `GET /v1/tasks/:id/events?after=0` | `{ items, nextCursor }` containing task events |
| `PUT /v1/attachments/:id` | `{ attachment, created }`, 201 for new or 200 for retry |
| `GET /v1/attachments/:id` | Attachment metadata |
| `GET /v1/attachments/:id/content` | Original validated image or text bytes |

Task status is `draft`, `queued`, `running`, `succeeded`, `failed`, `interrupted` or
`cancelled`. Lifecycle events use `task.<status>` (draft creation is `task.created`).
`task.output` events carry `channel` (`stdout` or `stderr`) and `text`; terminal
execution events can carry `exitCode` and a bounded error code. Repeated commands
do not duplicate lifecycle transitions.
Pages contain at most 50 items. `after` is an exclusive, nonnegative integer cursor;
`nextCursor` is null when that response has no further page. For continued event
polling, retain the largest event `sequence` received even when `nextCursor` is null.
Task-list cursors enumerate creation, not changes to previously listed tasks.
There is no SSE connection or automatic event subscription.

## Clone and register a repository

An execution-enabled runner advertises `projectCloning`. Cloning creates a durable
job and runs independently of the HTTP request. It does not start an AI task.

```sh
CLONE_KEY=$(node -p 'crypto.randomUUID()')
curl --fail-with-body -X POST "$RUNNER_URL/v1/projects/clone" \
  -H "Authorization: Bearer $RUNNER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"idempotencyKey\":\"$CLONE_KEY\",\"url\":\"git@github.com:YOUR-ORG/YOUR-REPO.git\",\"name\":\"my-app\",\"branch\":\"main\"}"
```

Set `RUNNER_URL` and securely provide `RUNNER_TOKEN` as in the examples below.
The response is a job directly, with no wrapping `job` property:

```json
{
  "id": "12345678-1234-4123-8123-123456789abc",
  "status": "queued",
  "project": null,
  "error": null
}
```

Poll `GET /v1/project-clones/:id`. Status is `queued`, `running`, `succeeded`,
`failed`, `interrupted` or `cancelled`. A successful job includes
`project: { id, name }`; the registered project can then be selected for task
start. Errors are bounded codes, not raw Git output. There is no clone-job list
or clone-output event endpoint. Keep the job ID and original idempotency key to
recover an uncertain response; identical admission with that key returns the
same job, while changed input conflicts. Retry an interrupted or failed attempt
with a new key after resolving the cause.

The body accepts only the five documented fields. `idempotencyKey` is a lowercase
UUID v4. `name` is also the destination folder name: 1–64 ASCII letters, digits,
underscores or hyphens, starting with a letter or digit. `branch` is optional and
must be a valid bounded branch name (at most 255 characters); omitting it clones
the default branch. URLs are at most 2,048 characters and accept the supported
HTTPS, `ssh://user@host/path` or `user@host:path` forms. Credentials in HTTPS URLs,
query strings, fragments, local paths and other protocols are rejected.

HTTPS can use the service account's authenticated `gh` or `glab` account for
exactly its configured host; only fixed provider credential helpers are enabled
and authenticated redirects are disabled. Otherwise HTTPS remains anonymous.
SSH uses the service account's existing keys and known hosts. Credentials never
pass through the editor and its SSH agent is not forwarded. Optional `parentPath`
selects an existing absolute directory beneath `CODEVO_PROJECTS_ROOT` (default
`~/Developer`); paths outside that root and symlink aliases are rejected.
Any existing destination file, directory or symlink is a conflict and is never
overwritten. Names already registered or reserved by another clone also conflict.

One clone runs at a time. Up to eight queued/running jobs are admitted, and at most
1,000 jobs are retained. Configured projects, managed projects and active clone
reservations share a 32-slot limit. There is no automatic history eviction or cloned-repository size quota.
Git has a ten-minute deadline; output is discarded rather than retained as a log.
Cancellation durably changes queued/running jobs to `cancelled` and stops the owned
Git process group. Late completion cannot overwrite a terminal state.

Successful project registration and the `succeeded` job transition commit together
in SQLite. Disconnecting the client does not stop a clone. Runner restart marks
both queued and running clone jobs `interrupted`, without automatic retry. Normal
failure/cancellation removes only the destination still owned by that operation;
an abrupt process death can leave a partial directory. Inspect that directory
before removing it, or retry with another name. These clone recovery rules differ
from the agent task queue, whose queued tasks remain eligible after restart.

## Upload then store a draft

Set `RUNNER_TOKEN` securely in your shell to the configured token; the examples use
that environment variable without printing or embedding its value. The local URL
may be the endpoint of an SSH tunnel. Replace the image path with your own file.

```sh
RUNNER_URL=http://127.0.0.1:4318
ATTACHMENT_ID=$(node -p 'crypto.randomUUID()')
TASK_KEY=$(node -p 'crypto.randomUUID()')

curl --fail-with-body -X PUT "$RUNNER_URL/v1/attachments/$ATTACHMENT_ID" \
  -H "Authorization: Bearer $RUNNER_TOKEN" \
  -H 'Content-Type: image/png' \
  -H 'X-File-Name: screenshot.png' \
  --data-binary @/absolute/path/screenshot.png

curl --fail-with-body -X POST "$RUNNER_URL/v1/tasks" \
  -H "Authorization: Bearer $RUNNER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"idempotencyKey\":\"$TASK_KEY\",\"provider\":\"codex\",\"parts\":[{\"type\":\"text\",\"text\":\"Inspect this screenshot\"},{\"type\":\"attachment\",\"attachmentId\":\"$ATTACHMENT_ID\"}]}"
```

Wait for successful upload before sending its reference. Keep the same attachment
ID and task key when retrying an uncertain response; do not regenerate them for a
retry. IDs and idempotency keys must be lowercase UUID v4. Reusing a task key with
different content or an attachment ID with different bytes/metadata yields 409.
Unknown attachment references fail admission. Task bodies reject unknown fields;
parts are ordered nonblank text or attachment references, with no duplicate attachment IDs.

`X-File-Name` is required and percent-encoded (for example `screen%20shot.png`).
It is display metadata, at most 255 UTF-8 bytes after decoding, with no path
separators or control characters. Upload content type is exactly `image/png`,
`image/jpeg` or `text/plain`; images must match and decode as a supported single image,
and text must be nonempty valid UTF-8 without NUL.
Content is sent directly, not base64 or multipart. No client filesystem path is
accepted by the API.

Copy the returned task ID into `TASK_ID` to inspect the draft:

```sh
TASK_ID=replace-with-returned-task-id
curl --fail-with-body "$RUNNER_URL/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
curl --fail-with-body "$RUNNER_URL/v1/tasks/$TASK_ID/events?after=0" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
```

To abandon a draft or stop a queued/running task, cancel it instead of starting it:

```sh
curl --fail-with-body -X POST "$RUNNER_URL/v1/tasks/$TASK_ID/cancel" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
```

Cancellation is optional; skip it to continue the execution walkthrough. Once
cancelled, create a new draft with a new task key before attempting execution.

## Start and observe a task

With the execution overlay enabled, use an uncancelled draft task ID:

```sh
curl --fail-with-body "$RUNNER_URL/v1/projects" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
curl --fail-with-body -X POST "$RUNNER_URL/v1/tasks/$TASK_ID/start" \
  -H "Authorization: Bearer $RUNNER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"projectId":"my-app"}'
curl --fail-with-body "$RUNNER_URL/v1/tasks/$TASK_ID/events?after=0" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
curl --fail-with-body "$RUNNER_URL/v1/tasks/$TASK_ID/diff" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
```

Start accepts `projectId` and optional `base`, never paths, clone URLs, executable names or
shell commands. Admission is persisted before the response. Retrying the same task
and project does not launch it twice; choosing another project conflicts. Terminal
tasks are not restarted. Provider installation and authentication happen on the
host, not through this API; a missing or unauthenticated CLI can fail execution.
The project list exposes IDs and names, not host paths.

After disconnecting, poll events with the largest received sequence to replay
missed output. Persisted output is retained in SQLite without a fixed per-task or
runner-wide lifetime byte/event quota. Individual events remain limited to 8 KiB;
read pages contain at most 50 items and 3 MiB of serialized item data. Task reads
use the same page bounds. Actual disk exhaustion fails truthfully; it never evicts
old events to make room for new output. Task history has no fixed lifetime count.

For output removed by an older runner, event pages still include the paired fields
`outputTruncatedBeforeSequence` (highest evicted output sequence, inclusive) and
`outputStartsAtLineBoundary` (whether retained stdout begins at a JSON-line boundary).
They are absent for histories with no legacy eviction. When the caller's last consumed sequence is below
the watermark, reset its partial parser; if the boundary flag is false, discard
stdout through the next newline before parsing subsequent frames. Retained lifecycle
records may precede the watermark and must still be processed. Show older output as
unavailable and continue consuming new output. Search marks retained-history results
incomplete when output was evicted. SQLite migration 7 persists these watermarks.

Event pages may also carry `subagentLifecycle`, a bounded snapshot of at most 32 child
agents kept outside the output window. Entries retain `taskTitle` (the spawn title,
written once), `batchKey` (frozen at the first sight of the spawn, with the still-open
batch in the root `openBatchKey`), `nestedCount` and `parentToolId` for nested agents,
and `countedNestedToolIds` so replays of the 32 most recent nested identities cannot
inflate the count. Nested entries carry no result frame and stay `running`. Bounds are byte-exact
and pinned by `test/fixtures/agent-subagent-lifecycle-wire.json`, shared with the
editor. Those fields are sent only to a client that announces
`subagentLifecycleRetention` in the `X-Codevo-Client-Capabilities` request header
(comma-separated, at most 16 printable-ASCII tokens and 512 characters; an absent,
oversized or non-ASCII header announces nothing). Every other client
receives the older closed shape: nested entries are removed and `truncated` becomes
true. The runner advertises `subagentLifecycleRetention` in `GET /v1/runner`. A
stored snapshot that cannot be read is dropped rather than failing the page.

Provider metadata and artifact discovery process the complete stream independently
of the retained replay window. There is no default lifetime process-output cutoff;
chunks use backpressure. Execution defaults to a 12-hour wall-clock deadline,
configurable from one minute to seven days; waiting for an answer counts toward
that deadline. See [execution policy](execution-policy.md). The legacy metadata
parser rejects individual frames over 64 KiB; interactive provider frames are
bounded to 8 MiB. Real persistence failures
still stop execution with `output_persistence_failed`. The runner checks actual filesystem free space and reserves 16 MiB of
headroom for state transitions; exhausted admission capacity returns a quota error.
SQLite has no application-specific database size ceiling.
This is persisted CLI stdout/stderr, not a parsed provider conversation. There is
no live SSE API. Approval interaction is described in [approvals.md](approvals.md).
Cancellation of a running task aborts its process group. Restart marks formerly
running tasks `interrupted` and leaves queued tasks eligible for execution; it does
not automatically resume an interrupted provider session. An explicit follow-up
can continue an eligible session as described below.

Diff compares tracked files with the task's original committed baseline, including
changes committed inside the task worktree. New untracked files are listed by name;
their contents are not included in `patch`. Diff and filename output are bounded
and `truncated` signals an incomplete result. A task with no project conflicts;
a worktree not yet created is not found. This endpoint does not transfer files or
apply changes to the editor's local checkout.

## Continue a provider session

An execution-enabled runner advertises `taskContinuation`. Continuation is explicit:
first inspect `GET /v1/tasks/:id/resume`, then submit the next turn to
`POST /v1/tasks/:id/continue`. Neither endpoint accepts a provider session ID,
workspace path or replacement provider from the client.

The eligibility response is exactly one of:

```json
{ "available": true, "reason": null }
{ "available": false, "reason": "task_not_finished" }
{ "available": false, "reason": "session_unavailable" }
{ "available": false, "reason": "newer_turn_exists" }
```

A finished task can continue only when it is the latest turn and has saved session
metadata and a usable original Git workspace (worktree or registered checkout). This check does not query the provider's
history store or prove login readiness. Missing, expired or rejected provider
history can still fail execution. The runner does not fall back to a new session.

Upload any new images before submitting their references. The continuation body
contains `idempotencyKey` and `parts`, with optional `launch` and `instructions`, and the same UUID, message-part,
prompt and attachment limits as draft creation:

```json
{
  "idempotencyKey": "12345678-1234-4123-8123-123456789abc",
  "parts": [{ "type": "text", "text": "Now add a regression test for that fix." }]
}
```

Successful admission creates and queues a new task atomically; no separate start
request is needed. Its provider and project come from the parent. The task includes
`parentTaskId` and `conversationId` (the original task ID). Existing task records
may omit these optional fields. Each turn has its own events and status, while
all turns share the original workspace and baseline. Only the latest turn can admit
a successor; continuation does not branch from older turns. Every new turn counts
against the runner-wide task and output quotas.

Reuse the same key and unchanged parts when retrying an uncertain response. An
identical retry returns the same task with `created: false`; changed input or a
noneligible parent conflicts. Do not generate a new key merely because the client
lost the response. Once a successor exists, its parent is no longer eligible.

The CLI resumes the server-owned provider session. Structured provider output is
checked against its expected session ID; a mismatched session or provider-reported
failure cannot be treated as successful continuation. Cancellation or service
restart stops the process as for other tasks. A finished failed, cancelled or
interrupted latest turn can be eligible for another explicit follow-up if its
session metadata and workspace remain available.

Historical tasks may recover a session ID from retained structured stdout, bounded
by the existing event/output limits. Recovery does not copy or repair the provider's
history. Missing output, missing history or relocated worktrees/source repositories
can prevent continuation. In particular, the same Git branch name does not identify
a provider conversation, and importing a local session does not transfer it here.

A conversation's diff is cumulative against its original baseline and reads its
current shared worktree, even when requested through an older turn's task ID. It
is not a frozen snapshot of that turn. Untracked file contents and local checkout
synchronization remain outside this endpoint's scope.

## Limits and errors

`LIMITS` in `src/domain/contracts.ts` defines the shared protocol limits. Additional
defensive image-envelope bounds are in `src/infrastructure/files/image-preflight.ts`.

| Resource | Maximum |
| --- | --- |
| Task JSON body | 4 MiB (4,194,304 bytes) reader limit; smaller per-route limits are listed in [HTTP boundary and capability negotiation](#http-boundary-and-capability-negotiation) |
| Combined prompt text | 48,000 UTF-8 bytes |
| Ordered parts / distinct attachments per draft | 16 / 8 |
| One uploaded image | 8 MiB |
| Image dimension / total pixels | 8,192 per side / 16,000,000 pixels |
| Image metadata aggregate | 256 KiB, counting encoded and inflated PNG metadata |
| Inflated compressed PNG metadata chunk | 64 KiB |
| PNG chunks / JPEG markers | 1,024 |
| Stored attachments / aggregate image bytes | 256 / 256 MiB |
| Stored tasks / output history | No fixed lifetime quota; available disk |
| Concurrent uploads / upload deadline | 2 / 30 seconds |
| Concurrent attachment-store reads (metadata and content combined) | 2 |
| Concurrent HTTP image downloads | 2, held until response finish/close |
| Task or event page | 50 items / 3 MiB serialized item data |

Unsupported image structures or malformed metadata fail closed; a PNG/JPEG extension
alone does not guarantee acceptance. Ancillary PNG chunks, including private and
unregistered ones, are accepted within the metadata and chunk-count limits; unknown
critical PNG chunks and malformed chunk types are rejected. Animated PNG (APNG
`acTL`/`fcTL`/`fdAT` chunks) is rejected as well. Quotas are runner-wide, not per user. The attachment-store read limit covers file/metadata
retrieval until bytes are returned to HTTP. A separate HTTP download limit remains
held until the response finishes or closes, including slow clients.
HTTP transport can terminate stalled requests
earlier than the attachment deadline. There is no automatic eviction of retained
records; task cancellation does not delete attachments or release storage quota.
Do not manually delete database rows/files to work around quotas.

Error bodies use `{ "error": "code" }`: invalid input is 400, missing records 404,
conflicting retries 409, oversized payloads 413, unsupported media 415, exhausted
quotas 429, and busy/unavailable storage 503. An unusable speech sidecar is 503
`speech_unavailable`. Authentication failures are 401;
Origin requests are 403. Upload deadline expiry may return 408 `request_timeout`
or close a stalled connection. Error responses never contain token or file contents.

## Per-file change review

Execution-enabled runners advertise `taskFileDiffs`. The files endpoint returns up to
1,000 entries shaped as `{ path, status, oldPath? }`; status is `added`, `modified`,
`deleted`, `renamed`, or `untracked`. Unsupported filename encodings and result limits
set `truncated: true`. Names are relative to the conversation's original worktree.

The file-diff endpoint accepts exactly `{ "path": "src/example.ts" }` and returns
`{ path, original: { text, truncated }, modified: { text, truncated }, unavailableReason }`.
`unavailableReason` is `null`, `binary`, or `large`. Each side is limited to 64 KiB of
UTF-8; binary or oversized results return empty text on both sides rather than a
misleading partial diff. Large results set both truncation flags. Missing/deleted sides
are empty text with `truncated: false`. Original text comes from the conversation's
saved baseline; current text reflects the same worktree used by later turns.

Paths cannot be absolute or contain backslashes, control characters, empty segments,
`.`/`..`, or `.git` segments. Current-file reads reject symlinks, hardlinks, and special
files; directory traversal and Git inspection retain the verified workspace identity.
Python 3 is required for this descriptor-based boundary. Missing Python or invalid
workspace authority returns an error, never a successful empty review.

### Runner change notifications

Native clients may upgrade `GET /v1/changes` to WebSocket. The upgrade requires
exactly one `Authorization: Bearer …` and one `x-codevo-runner-id` header matching
this runner. Origins, request bodies, query strings and application messages from
clients are rejected. Ping/pong control frames are supported. This endpoint is
additive; older runners return an unsupported-route response and clients must
retain their bounded polling fallback.

Every connection receives an immediate JSON snapshot:
`{"type":"snapshot","runnerId":"…","epoch":"UUID","revision":0}`.
After durable task, output, resume-session or project-clone changes, the server
sends the same shape with `"type":"changed"`. Notifications coalesce over 100 ms;
revision numbers can skip. They are invalidations, not task events. On **every**
new connection or epoch change, reload authoritative inventory and resume existing
per-task HTTP event cursors. Never interpret revision gaps as missing transcript
messages, and never treat a disconnected subscription as current state.

The process epoch changes on restart. There is no retained notification queue or
subscription replay log. Existing durable task event APIs remain the replay source.
There are at most 16 subscriptions, a 256-byte incoming application-frame limit,
a 16 KiB outbound backlog cutoff and a 15-second ping cadence. Unresponsive peers
are terminated on the following heartbeat; server shutdown terminates subscriptions
and removes listeners/timers. No token or provider output is included in notifications.

## Retained history search

`GET /v1/history/search?q=<literal>&after=<task-sequence>&projectId=<optional>`
uses the same bearer authorization and pinned runner identity as task routes.
`q` is a literal case-insensitive substring, trimmed, 2–256 characters (at most
1024 UTF-8 bytes). `after` defaults to zero; unknown and duplicate query fields
are rejected. Optional `projectId` is 1–128 characters.

The response is `{ items, nextCursor, scope: "retained_runner_history", incomplete }`.
Each item contains `taskId`, `conversationId`, nullable `projectId`, `taskSequence`,
`role` (`user` or `assistant`), nullable `eventSequence`, and a bounded `snippet`.
One first match per role per task is returned; it represents matching tasks, not
an exhaustive list of occurrences. `eventSequence` locates the first persisted
output chunk contributing to the matching provider record.

Each page examines at most ten tasks, including nonmatching and foreign-project
tasks, off the HTTP thread in the SQLite worker. Clients must continue when
`nextCursor` is non-null even when `items` is empty. Cursors advance by task
sequence without duplicate task matches; they do not provide a frozen snapshot
of actively changing output. Restart a search to include changes to earlier tasks.

Search includes all retained task prompts and recognized Claude assistant text/
result records and Codex completed agent messages, regardless of UI history
pagination. It excludes tool output, stderr, images, and provider-only history
that has never been persisted by this runner. `incomplete` signals malformed
provider records or an exceeded event scan bound in this page; a null cursor
means the retained task scan ended, not that omitted/provider-only history exists
in this database. Active incomplete JSON records can mark a page incomplete.

## Pending conversation messages

The `pendingMessages` discovery capability advertises durable followups while a
conversation is running. These messages are separate from executed task history.
The task ID in each route identifies its server-owned conversation; callers never
provide a provider session ID or workspace path.

- `GET /v1/tasks/:id/pending` returns `{ items }` in FIFO order, at most 16 active messages.
- `POST /v1/tasks/:id/pending` accepts the same closed `{ idempotencyKey, parts, launch?, instructions? }`
  body as continuation. It returns `{ pending, created }` (202, or 200 for an identical retry).
- `DELETE /v1/tasks/:id/pending/:pendingId` returns the cancelled message. Repeating
  removal is safe; removing an already dispatched message returns conflict.
- `POST /v1/tasks/:id/pending/resume` accepts no body and returns `{ items }`. It
  explicitly resumes a paused queue only when the latest turn has a usable saved session.

A pending message contains `id`, `conversationId`, `status`, `parts`, `createdAt`,
`taskId` (null until dispatched), and optional `launch`. Status is `queued`, `paused`, `uncertain`,
`dispatched`, or `cancelled`; the list excludes dispatched and cancelled records.
Both message content and image references are retained in SQLite. The queue has a
16-message active limit per conversation and a 1,000-record lifetime retention limit
for durable retry identities. Exhaustion returns `quota_exceeded`; records are not
silently evicted. Removal retains its retry identity.

After a successful settled turn with saved provider identity, the worker atomically
promotes one head message into a normal continuation task. HTTP/SSH disconnect does
not prevent subsequent messages from running. Stop, execution failure and service
restart pause undispatched messages. Restart does not replay the interrupted turn.
Explicit queue resume is required after a pause; sending an unrelated continuation
or adding another pending message does not silently release a paused queue. Admission
failures such as task quota pause the affected queue without stopping unrelated tasks.

## Output artifacts

Execution-enabled runners advertise `outputArtifacts: true`. Both Codex and Claude
assistant Markdown references to PNG, JPEG, WebP or self-contained HTML workspace
files are captured before a task finishes and before a subsequent turn starts.
Snapshots are immutable and remain available after restart or worktree deletion.
This feature transports generated files; it does not supply an image-generation tool.

- `POST /v1/tasks/:taskId/artifacts`, JSON `{ "path": "design.html" }`: replay an
  existing snapshot or capture a terminal task's file. Absolute paths are accepted
  only inside its assigned worktree. Returns `{ artifact, created }` with 201 or 200.
- `GET /v1/tasks/:taskId/artifacts`: `{ items: [...] }`, at most 32 snapshots.
- `GET /v1/tasks/:taskId/artifacts/:artifactId/content`: authenticated original
  bytes, with attachment disposition, no-store, nosniff and restrictive CSP.

Metadata fields are `id`, `taskId`, `name`, `mediaType`, `sizeBytes`, and `sha256`.
Requests use the same runner identity/authentication rules as other task endpoints.
Limits are 8 MiB per image, 2 MiB per UTF-8 HTML file, 8,192 pixels per dimension,
16 million image pixels, 32 files per task and 1 GiB total stored output. Animated
images, SVG, arbitrary downloads, symlink/hardlink sources and path escapes are
unsupported. The editor must render HTML in an isolated, network-free sandbox.
At most two downloads and one capture are admitted concurrently. Automatic capture
has a 30-second admission budget; failures add a bounded stderr notice and do not
turn a successful provider response into a failed task. Explicit capture returns
conflict for running tasks or uncaptured obsolete turns; existing snapshots replay.

SQLite migration 6 adds artifact metadata. Private blobs live in `artifacts/`
beside the database; back up both. Startup reconciles uncommitted files left by a
crash. Automatic discovery streams without a lifetime byte cutoff, with a
256 KiB frame bound, and recognizes inline Markdown links/images, excluding
tool/user/subagent messages. Oversized frames are skipped through their newline;
discovery resumes and reports incomplete capture. Legacy turns without a saved snapshot still require their source files.

### Interactive questions

When `interactiveQuestions` is advertised, a running task can pause for a structured
provider question. `GET /v1/tasks/:taskId/questions` returns `{items: [...]}` with
bounded durable requests. Each request has `id`, `taskId`, provider (`codex` or
`claudeCode`), `questions`, and `status` (`pending`, `answered`, `cancelled`, or
`expired`). Each question has `id`, `header`, `prompt`, `options` (id, label,
description), `multiple`, and `allowCustom`.

`POST /v1/tasks/:taskId/questions/:requestId/answer` accepts
`{answers: [{questionId, optionIds: [...], text: "..."}]}` and returns
`{request: ...}`. Every question must be answered exactly once. Option identifiers
must belong to that question; free text requires `allowCustom`. Answered requests
include `answers`. An exact retry is idempotent; a different or stale answer is a
conflict. A response resumes the existing provider process, never a queued turn.

Closing an editor or losing its connection does not cancel the pending question.
Reconnect and fetch requests again. Cancelling the task cancels pending questions;
runner restart or provider exit expires pending questions truthfully. The configured
task execution deadline still applies while waiting for an answer. Authentication
and runner identity checks are identical to other task routes.


History search remains a bounded scan of the first 1,024 output events and 1 MiB
per task; it reports `incomplete` when further output exists. This search bound
never removes data from durable event history. Generated artifacts retain an
independent admission limit of 32,000 items across the runner, so startup blob
reconciliation stays bounded even as task history grows. Existing captures remain
readable and idempotent at that limit.

## Project and thread management

All routes below require bearer authentication and the exact `X-Codevo-Runner-Id`.
Discovery advertises `projectManagement` and `threadManagement` only when matching
`X-Codevo-Client-Capabilities` tokens are supplied. Unsupported services are false.

| Route | Request / response |
| --- | --- |
| `GET /v1/repositories/hosts` | GitHub and configured GitLab host authentication snapshots, no credentials |
| `POST /v1/repositories/lookup` | `{provider,host,path}` → exact repository or typed failure |
| `POST /v1/repositories/search` | `{provider,host,query,page}` → `{status:"ok",repositories,nextPage,truncated}` or typed failure |
| `POST /v1/project-directories` | `{path?}` → `{path,parentPath,entries:[{name,path}],truncated}` |
| `GET /v1/tasks/:id/thread-metadata` | Canonical conversation metadata, defaults have revision zero |
| `PATCH /v1/tasks/:id/thread-metadata` | `{expectedRevision,...changedFields}` → committed metadata; stale revision returns HTTP 409 |
| `GET /v1/thread-metadata?after=:id` | `{items,nextAfter}`; optional cursor, 100 persisted records per page |
| `POST /v1/tasks/:id/thread-order` | `{targetTaskId,placement:"before"|"after"}` → `{items}` changed metadata records |

Repository operations allow only server-discovered authenticated hosts. Search uses
20 results per page, at most 10 pages, with explicit truncation when more results
exist. At most two lookup operations run concurrently; each CLI process is bounded
by 15 seconds, 256 KiB stdout and 64 KiB stderr. Lookup requests are at most 4 KiB.

Directory requests are at most 8 KiB. Paths use at most 4096 UTF-8 bytes. Listings
inspect at most 4096 entries and return at most 256 directories within a 128 KiB
name/path budget, indicating truncation. Symlink entries are excluded. Browse never
changes the allowed root, and a root listing returns `parentPath: null`.

Metadata has `taskId`, `revision`, nullable `title` (256 UTF-8 bytes), boolean
`pinned`, `archived`, `removed`, nullable `viewedAtEpochMs`, `snoozedUntil`,
`settledAt` (integer milliseconds between zero and 8.64e15), and nullable finite
`sortOrder` within JavaScript's safe integer magnitude. Patches reject unknown
fields, empty changes and invalid values; request bodies are at most 4 KiB.
Continuation task IDs resolve to the same conversation root. Metadata persists
across restarts, and changes notify all connected clients through inventory events.

Reordering resolves both conversation roots and uses their current metadata in one
transaction. Only visible conversations in the same project and sidebar section
can be reordered. At most 256 records in that section are renumbered; larger
sections return HTTP 429 without partial changes. This endpoint moves relative to
an anchor rather than accepting a stale full ordering from the client.

## Immutable changes for an individual turn

Clients announcing `turnChanges` in `X-Codevo-Client-Capabilities` can discover the
optional `turnChanges` capability. Older clients do not receive this field.

- `GET /v1/tasks/:id/turn-changes` returns `{turnId,state,files,truncated,reason}`.
- `POST /v1/tasks/:id/turn-file-diff` accepts exactly `{relativePath}` and returns
  `{relativePath,original:{text,truncated},modified:{text,truncated},unavailableReason}`.

Both routes require authentication and the pinned Runner identity. The task ID is
an individual provider turn, including each continuation, not the conversation
root. File entries contain `relativePath`, nullable `oldRelativePath`, `status`,
and nullable `addedLines`/`deletedLines` counts. Binary or large-file line counts
are both null, and their diff has `unavailableReason: "binary" | "large"`.

The Runner captures the on-disk working tree immediately before provider execution
and again after it exits, before publishing normal completion. Existing dirty
files form part of the baseline and are not reported unless they change during
that turn. Commits made during execution do not erase the turn's changes. Saved
results do not change when another turn or a manual edit modifies the workspace.
Concurrent human edits during execution are part of the same before/after change
set; snapshots do not establish which process authored a change.

Historical tasks without snapshots, interrupted/cancelled captures, unsupported
files and exhausted capture/storage budgets return `state: "unavailable"` with a
bounded reason. They never fall back to the current working tree or cumulative
conversation diff. A ready result returns at most 500 changed files and explicitly
indicates truncation. Each text side is bounded to 128 KiB; paths are at most 4096
UTF-8 bytes and 64 segments. Capture has a 10-second execution deadline, bounded
file/byte scanning and a 256 MiB retained-store quota. Existing historical records
are not overwritten to admit new snapshots.

## Git sync

Clients announcing `gitSync` in `X-Codevo-Client-Capabilities` discover the optional
`gitSync` capability; the `gitSync` field is true when both execution and the Git sync service are present. All routes require
bearer authentication and the exact `X-Codevo-Runner-Id` (missing or foreign: 409).
Paths are exact; query strings are 404 and bodies on GET are 400. Bodies are closed
JSON objects: unknown fields are 400. `:projectId` uses the registered project id
grammar and `:id` is a task uuid resolving to its conversation workspace.

| Route | Request / response |
| --- | --- |
| `GET /v1/projects/:projectId/git/branches` | `{defaultBranch,checkoutBranch,fetchedAt,branches:[{name,sha,committedAt}],truncated}` |
| `POST /v1/projects/:projectId/git/fetch` | `{idempotencyKey}` → 202 `GitOperation` (`fetch`) |
| `GET /v1/projects/:projectId/git/status` | `{branch,headSha,upstream,dirty,operation,inPlaceTaskActive,fetchedAt}` |
| `POST /v1/projects/:projectId/git/update` | `{idempotencyKey}` → 202 `GitOperation` (`update`) or an admission refusal |
| `GET /v1/tasks/:id/git/status` | `{mode,branch,headSha,base,published,dirty,active}` |
| `POST /v1/tasks/:id/git/commit` | `{message}` → `{commitSha,status}` |
| `POST /v1/tasks/:id/git/push` | `{idempotencyKey,target:"thread-branch"|"base-branch"}` → 202 `GitOperation` (`push`) or an admission refusal |
| `GET /v1/git-operations/:id` | `GitOperation` `{id,kind,status,error,result}`; 404 when unknown or expired |

`POST /v1/tasks/:id/start` accepts an optional `base`: `{kind:"origin-branch",branch}`
(worktree isolation only) or `{kind:"checkout-head"}` (previous behaviour). An
`origin-branch` start fetches origin (coalesced with a fetch that finished less than
15 seconds earlier), resolves `refs/remotes/origin/<branch>` and creates the worktree
on a new local branch `codevo/<first 8 hex of the task id>` (the full 32 hex id on
collision). A failed fetch or missing branch fails the turn with that Git error code
before the provider starts; there is no fallback to the stale checkout. Without a
base, worktrees keep the detached `HEAD` behaviour. The base is stored with the task;
retrying start with a different base is a conflict.

Branch names use the clone branch grammar, at most 255 UTF-8 bytes, never `HEAD` and
never starting with `+`; remote branches outside the grammar are omitted from the
listing. Listings return at most 500 branches, newest commit first, with `truncated`.
Shas are 40 or 64 lowercase hex. Dirty counts stop at 10,000 (`truncated`). Commit
messages are 1–4096 UTF-8 bytes, not whitespace-only, without control characters
except `\n`; a commit stages every change except runner-managed synchronized
instruction files (`.codevo-instructions/global/`, `.claude/rules/codevo-global/` and
the instruction manifest's paths), which status also omits from dirty counts. It is refused while a turn of the
conversation (or, for in-place threads, any in-place turn of the project) is queued
or running. Commit identity is `CODEVO_GIT_AUTHOR_NAME`/`CODEVO_GIT_AUTHOR_EMAIL`, else
the repository-local `user.name`/`user.email`, else `git_identity_missing`.

Push never forces, never pushes tags and always sends one explicit
`<sha>:refs/heads/<branch>` refspec to the origin URL. `thread-branch` publishes the
recorded `codevo/...` branch, the in-place checkout branch, or `codevo/<id8>` for a
legacy detached worktree. `base-branch` is available only for worktrees started from
an origin branch and is fast-forward only (`git_rejected_non_fast_forward`). Update
from origin fetches and runs `merge --ff-only` on the server checkout; it is refused
while an in-place turn is queued or running (`busy`), and for a detached checkout,
missing or non-origin upstream, an in-progress merge/rebase/cherry-pick/revert/bisect,
tracked changes, or divergence after the fetch. A status whose output exceeds its
bounds (256 KiB or 10,000 entries, for example an unignored dependency tree) counts as
dirty for Update. The merge has its own 10-second deadline and does not start when less
than that remains of the update budget.

Network operations are polled jobs keyed by `idempotencyKey`: the same key with the
same input returns the same operation and a different input is 409 `conflict`. At
most 64 operations are retained in memory; completed ones expire after 10 minutes and
all are lost on restart (poll 404 means the outcome is unknown; refresh status). At
most two network Git operations run runner-wide and one per project. Deadlines are
60 seconds for fetch, 60 seconds for update, 120 seconds for push and 10 seconds per
local Git command. On deadline or shutdown the process group receives SIGTERM, so
Git can remove its lock files, and SIGKILL two seconds later.
Network Git uses the service account's SSH keys with strict host keys and no agent
forwarding, or the host-scoped `gh`/`glab` credential helper for HTTPS. Origin URLs
and push URLs with credentials, local paths or unsupported transports are refused
(`git_remote_unsupported`); a missing origin is `git_no_remote`. Repository hooks,
fsmonitor, configured credential helpers, signing, tag following and submodule
recursion are disabled. Git output is never returned; stderr is read up to 16 KiB
only to classify failures.

Operation failures and admission refusals use the closed codes `git_remote_unavailable`,
`git_auth_failed`, `git_timeout`, `git_no_remote`, `git_remote_unsupported`,
`git_branch_not_found`, `git_detached_head`, `git_no_upstream`, `git_dirty`,
`git_diverged`, `git_operation_in_progress`, `git_rejected_non_fast_forward`,
`git_rejected`, `git_nothing_to_commit`, `git_identity_missing`, `busy` and
`conflict`. As HTTP errors, `git_*` codes and `conflict` are 409 and `busy` is 503.

A follow-up turn waits (at most 130 seconds, then fails as busy) for a commit or push
holding its workspace before the provider starts. Same-uid agents can still change
repository configuration such as clean/smudge filters used while staging; this is a
documented residual bounded by the process deadline. The origin URL check applies to
the configured `remote.origin.url`/`pushurl`; repository-local `url.*.insteadOf` and
`pushInsteadOf` rewrites still apply to fetch and push, within the protocols allowed above.
A turn that cannot obtain its workspace lease fails with the error `busy`.

## Port preview

Clients announcing `portPreview` in `X-Codevo-Client-Capabilities` discover the
optional `portPreview` capability. It is true only on Linux with execution enabled;
elsewhere it is false and both routes return 404. Authentication, runner identity,
exact paths and query-string rules match Git sync; only GET is allowed.

| Route | Listed processes |
| --- | --- |
| `GET /v1/tasks/:id/ports` | The running turn of the task's conversation (its provider and every descendant) as `agent`, plus terminals opened for any task of that conversation as `terminal`. Unknown tasks are 404. |
| `GET /v1/projects/:projectId/ports` | Running in-place turns of the project as `agent`, plus the project terminal (opened without a task) as `terminal`. Unknown projects are 404. |

Both return `{ports:[{port,address,source,process}],truncated,scannedAt}`. Only TCP
sockets in `LISTEN` state held by those exact process trees are reported, and only
when bound to `127.0.0.1` or `::ffff:127.0.0.1` (`loopback-v4`), `::1`
(`loopback-v6`), `0.0.0.0` (`any-v4`) or `::` (`any-v6`); specific non-loopback binds cannot be reached through a
loopback forward and are omitted. Ports below 1024 and the runner's own listen port
are never reported. `process` is the executable's base name (falling back to the
kernel `comm`), printable ASCII of at most 15 bytes, else `unknown`. Entries are
unique and strictly ordered by port, then address (`loopback-v4`, `loopback-v6`,
`any-v4`, `any-v6`), then source (`agent`, `terminal`); at most 32 are returned.

Discovery reads `/proc` without spawning processes: each owned pid's `fd` directory
(at most 1024 descriptors per process and 16,384 per scan) is matched against
`/proc/net/tcp` and `/proc/net/tcp6` (at most 4 MiB and 65,536 rows each), and a pid
whose kernel start time changed during the scan is discarded. `truncated` is true
when any of these bounds, the 2-second scan deadline, an unreadable descriptor or
an incomplete process tree may have hidden a listener, or when more than 32 ports
qualify. A scan that has not settled 500 ms after its deadline fails with 503
`busy`. A scope's result is cached for one second; at most four scans run at once
and a further scope is refused with 503 `busy`. Terminal sessions whose workspace no
longer revalidates are closed instead of listed.

Servers started by an agent live only while its turn runs, because the runner kills
the turn's tracked process tree when the provider exits. Use the conversation's
terminal for a server that should keep running. Process trees are observed every
100 ms for turns and every second for terminals; a server that detaches from its tree
faster than that (for example a double-forking daemon) is neither tracked nor listed.

A failed observation does not end a turn at once. A process whose `/proc` entries
cannot be read is skipped for that pass, together with any of its descendants that
are not yet known, while every other known process is still walked; the pass counts
as failed. The turn continues until 50 observations in a row fail (about 5 seconds)
or 600 observations have failed in total, whichever comes first. A permission or
path error (`EACCES`, `EPERM`, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG`), an error without
an errno and the process tree size bound end it immediately. Discovery is degraded
while observations fail: a descendant that starts in its own session and loses its
parent during that time is neither tracked nor killed. The final sweep kills every
process known by then whose kernel start time it can still verify. A turn that ends
with `process_cleanup_failed` could not be confirmed as fully inspected and killed,
so a descendant may have survived. Lines starting with `[Codevo] Process tree` in a
turn's stderr output name only the phase (`attach`, `observe` or `kill`), the errno
or error name, and failure counts; none are stored after the turn is cancelled.

## HTTP boundary and capability negotiation

The current JSON reader accepts at most 4 MiB (4,194,304 bytes), including for task
creation, continuation, steering, pending messages and surface/terminal commands.
Repository lookup/search and thread metadata/order use 4 KiB, project directories
and turn-file-diff use 8 KiB, Git fetch/update/push use 1 KiB, and Git commit uses
32 KiB. JSON requires `application/json`, optionally `; charset=utf-8`, and rejects
Content-Encoding with 415 `unsupported_media`. Invalid JSON or UTF-8 is 400
`invalid_input`; exceeding the applicable body limit is 413 `too_large`.
Attachment uploads have a separate 8 MiB transport bound, with the text-specific
limit described below. These are current reader limits for the additional contracts.

The HTTP boundary matches the complete request URL against the allowlist before
controller dispatch. Lowercase UUID v4 path identifiers and project IDs matching
`[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}` are required where those segments occur.
After the 401 and identity checks (including the missing-identity 409 for any URL
under `/v1/repositories/` or beginning `/v1/thread-metadata`), an unlisted URL is
404 `not_found`; a URL matching a listed pattern for a different method is 405
`method_not_allowed`. Queries are allowed only in the forms documented for that
route. In particular, task creation with `?after=...` is rejected with 404.
Requests carrying any Origin header receive 403 `origin_not_allowed`, including
health and discovery. A body on a route that does not accept one receives 400
`body_not_allowed`. Bearer authentication failure is 401 `unauthorized`.

`X-Codevo-Runner-Id` is optional on ordinary task, attachment, clone, project-list,
history-search, steering, surface and terminal routes. When supplied on any `/v1/`
HTTP route it must equal the runner identity, otherwise 409
`runner_identity_mismatch`; duplicate identity headers are 400
`duplicate_runner_identity`. It is required on account usage, Git sync, port
preview, turn changes, repository lookup/hosts/search, project directories and
thread metadata/order routes (including the metadata list); missing identity there
is 409 `runner_identity_mismatch`. Repository identity also requires it, but its
controller returns 409 `conflict` when it is missing. Discovery accepts an optional
matching identity. Disabled services return 404 `not_found` on their routes.
Unexpected controller failures return 500 `internal_error`. Other route-specific
errors below use the same `{ "error": "code" }` envelope.

`X-Codevo-Client-Capabilities` is comma-separated, case-sensitive, and optional.
The reader accepts at most 512 printable ASCII characters and 16 comma-separated
entries, trims each entry, and retains tokens matching `[A-Za-z][A-Za-z0-9]{0,63}`.
An oversized, non-ASCII or non-string header, or more than 16 entries, announces
nothing; invalid individual tokens are ignored. The complete list of tokens that
currently change server behavior is:

| Token | What it switches on |
| --- | --- |
| `accountUsage` | Adds the boolean `accountUsage` discovery field; true when an account-usage service exists. |
| `turnChanges` | Adds the boolean `turnChanges` discovery field; true when execution supports both turn summary and turn file diff. |
| `gitSync` | Adds the boolean `gitSync` discovery field; true when execution and Git sync services exist. |
| `portPreview` | Adds the boolean `portPreview` discovery field; true on Linux when execution and port services exist. |
| `projectManagement` | Adds the boolean `projectManagement` discovery field; true when repository, directory and clone services all exist. |
| `threadManagement` | Adds the boolean `threadManagement` discovery field; true when thread metadata exists. |
| `subagentLifecycleRetention` | Selects the retained subagent lifecycle shape on task event reads, as described in [Start and observe a task](#start-and-observe-a-task). |

The first six fields are omitted unless announced and defined in the descriptor.
These tokens do not gate route access. Other syntactically valid tokens have no
current effect. In particular, `taskLaunchOptions`, `taskSteering`, `taskIsolation`,
`instructionSync`, `textAttachments`, `pendingMessages`, `interactiveQuestions`,
`outputArtifacts`, `subagentTelemetry`, `taskFileDiffs`, `taskContinuation`,
`taskExecution`, `eventReplay`, `taskDrafts`, `imageAttachments` and `projectCloning`
are discovery fields, not additional recognized header switches. With services
installed, execution determines the task feature booleans; questions, artifacts
and cloning depend on their services. Instruction sync additionally requires Linux.
Drafts, image/text attachments, event replay and subagent lifecycle retention are
advertised as true in that configuration. Surface support is discovered per project
using the route below, rather than through another client token.

## Task launch, isolation and instruction input

`POST /v1/tasks` accepts the closed body
`{ idempotencyKey, provider, parts, isolation?, launch?, instructions? }`.
`provider` remains `claude` or `codex`. `POST /v1/tasks/:id/continue` and
`POST /v1/tasks/:id/pending` accept the closed body
`{ idempotencyKey, parts, launch?, instructions? }`; they inherit the provider and
isolation. These routes require bearer authentication, accept optional matching
runner identity, and have no client-capability gate. Their success responses and
retry statuses are as described in the draft, continuation and pending sections.
Task responses include optional `isolation` and `launch`; pending responses include
optional `launch`. Controllers remove `instructions` from both public record types.
The public Task shape is `{ id, sequence, runnerId, provider, status, parts,
createdAt, projectId?, conversationId?, parentTaskId?, isolation?, launch? }`;
`createdAt` is a string and `sequence` is a number.

`isolation` is `worktree` or `in-place`; omission uses worktree execution.
In-place execution uses the registered checkout. Continuations retain their parent's
isolation. Start's optional `base` is described in [Git sync](#git-sync);
`origin-branch` with in-place isolation is 400 `invalid_input`.

`launch` is a closed provider-specific object. It must match the draft or inherited
provider (`claudeCode` for `claude`, `codex` for `codex`). `model` and `mode` are
required. A model is 1-96 lowercase ASCII characters matching
`[a-z0-9][a-z0-9._-]{0,95}`; `default` emits no model override. The parser does not
validate model availability against a provider catalog.

| Launch provider | Fields and accepted values |
| --- | --- |
| `codex` | Required `provider: "codex"`, `model: string`, `mode: "default" | "readOnly" | "workspaceWrite" | "auto" | "dangerFullAccess"`; optional `effort: "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"`. Omitted/default effort is normalized away. |
| `claudeCode` | Required `provider: "claudeCode"`, `model: string`, `mode: "default" | "plan" | "supervised" | "acceptEdits" | "auto" | "bypassPermissions"`, `effort: "default" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode" | "ultrathink"`; optional `context: "200k" | "1m"` (default `200k`), `fastMode: boolean` and `thinkingMode: boolean` (both default false). |

The shipped runtime runs Codex through `codex app-server`: a nondefault `model`
is sent on thread start/resume and turn start, and a nondefault `effort` on
`turn/start`. `default` mode sends no sandbox override; `readOnly` sends `read-only`;
`workspaceWrite` and `auto` send `workspace-write` (network access off, writable
root is the workspace); `dangerFullAccess` sends `danger-full-access`, always with
`approvalPolicy: "never"`. The `-m`, `--sandbox`, `-c sandbox_mode=...`,
`-c model_reasoning_effort=...` and `--dangerously-bypass-approvals-and-sandbox`
arguments apply only to the non-interactive `codex exec` path.
Claude `default` supplies no permission override, `supervised` supplies permission
mode `default`, `bypassPermissions` emits `--dangerously-skip-permissions`, and the
other modes pass through. Nondefault model emits `--model`; context `1m` appends
`[1m]` except for `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-5` and
`claude-haiku-4-5`. `ultracode` maps to CLI effort `xhigh` and the ultracode setting;
`ultrathink` modifies the prompt with `Ultrathink:` unless already prefixed or a
slash command, and emits no effort flag. Other nondefault efforts pass through.
Fast/thinking flags set provider settings when true; Haiku instead always receives
the thinking boolean and does not receive fast/ultracode settings from this mapper.
These are argument mappings, not guarantees about the installed CLI's behavior.

Omitting `launch` on continuation or pending admission inherits the latest launch.
`instructions` is a closed `{ version: 1, files: [...] }` snapshot. Each file is
exactly `{ scope: "global" | "project", path: string, content: string }`.
At most 128 files, 65,536 UTF-8 bytes per content, and 524,288 aggregate content bytes
are allowed. Paths are relative Markdown paths (case-insensitive `.md` suffix),
at most 512 UTF-8 bytes and 32 segments. Empty, dot, parent, trailing-dot or
trailing-space segments, backslashes, colon, control characters and DEL are invalid.
Paths cannot duplicate or prefix-conflict within a scope after NFC normalization
and lowercasing. Files are sorted for retry comparison. An empty file list is valid.
A continuation/pending request must supply a snapshot if its parent/latest task had
one; omission is 400 `invalid_input` rather than implicit inheritance.

Malformed/unknown fields and provider mismatches return 400 `invalid_input`;
exceeded text, attachment-count or instruction bounds return 413 `too_large`.
Missing attachment records return 404 `not_found`; changed retry input or
ineligible continuation returns 409 `conflict`; disk capacity can return 429
`quota_exceeded`, execution starting, stopping or failed returns 503 `busy`, and
unavailable storage returns 503 `storage_unavailable`. See the shared
body/media rules above for transport errors.

## Steering a running turn

`taskSteering` is advertised with execution enabled. Neither steering route has a
client-header capability gate or requires the runner identity when omitted.

| Route | Body / response |
| --- | --- |
| `POST /v1/tasks/:id/steer` | Exactly `{ idempotencyKey, parts }`; HTTP 200 `{ taskId, messageId, status: "accepted" }`. |
| `POST /v1/tasks/:id/pending/:pendingId/steer` | No body; HTTP 200 with the same receipt, using the stored pending message. |

The key is a lowercase UUID v4; `parts` has the same closed text/attachment shapes
as a draft, 1-16 parts, up to eight distinct attachment references and 48,000 UTF-8
bytes of combined nonblank text. Upload attachments first. Launch and instruction
overrides are not accepted in direct steering. The addressed task must be the
latest running turn and have a ready provider steering handler. Pending steering
requires a queued message from the same unpaused conversation with launch and
instructions exactly matching the running task. A provider tool boundary can also
consume a compatible head pending message automatically.

Acceptance persists a `task.input` event with `messageId` and `parts`. Pending
acceptance marks that message dispatched to this task, without creating a new turn.
An identical accepted retry returns the receipt even after the turn ends. A changed
key payload, inactive/unready turn, paused/incompatible message or definitive
provider rejection returns 409 `conflict`. An uncertain provider write or unaccepted
persisted claim returns 409 `delivery_uncertain`; it is retained to prevent duplicate
delivery, including after restart. Do not replace the key to redeliver blindly.
Pending messages with an unaccepted claim can be listed with status `uncertain`.

Zero or more than 16 parts, blank text and duplicate attachment IDs are 400
`invalid_input`; more than 48,000 text bytes or more than eight attachment references
is 413 `too_large`. Other invalid input is 400 `invalid_input`; missing pending/attachment
records can be 404 `not_found`; execution disabled is also 404. An unknown or
non-running task ID on either steering route is 409 `conflict` when no accepted
retry receipt exists. Other errors include
unavailable attachment staging 415 `unsupported_media`, retained quota exhaustion
429 `quota_exceeded`, overlapping steering on one turn or execution starting,
stopping or failed 503 `busy`, and storage
failure 503 `storage_unavailable`. At most 32 steering claims per task and 1,000
runner-wide are retained. At most eight additional staged attachments are retained
for a live provider process through its completion.

## Account usage

`GET /v1/account-usage/:provider` accepts exactly `claude` or `codex`, no query or
body, and requires the exact `X-Codevo-Runner-Id`. Announce `accountUsage` to see its
discovery boolean; the route itself is not gated by that token.

HTTP 200 returns `{ provider, fetchedAtEpochMs, windows, accountIdentity? }`.
The response provider is `claudeCode` or `codex`. `fetchedAtEpochMs` is a nonnegative
safe integer. There are 1-12 windows, each exactly `{ id, label, usedPercent,
windowDurationMinutes, resetsAtEpochMs, resetsLabel }`. IDs are unique; ID and label
are nonblank strings of at most 160 UTF-8 bytes without control characters.
`usedPercent` is finite and between 0 and 100 inclusive. Duration and reset time
are nullable nonnegative safe integers; `resetsLabel` is null or nonblank text of
at most 200 UTF-8 bytes without control characters. Optional `accountIdentity` is
null or `account:v1:sha256:` followed by 64 lowercase hex characters.

Reads are account-level and concurrent requests for the same provider share one
in-flight read (at most two provider reads). Missing service or unsupported URL is
404 `not_found`; provider-read, validation or shutdown failures are 503
`storage_unavailable`. Identity and other boundary failures follow the rules above.

## Project workspace surfaces

These routes accept optional matching runner identity and have no client capability
gate. `GET /v1/projects/:id/surface/capabilities` accepts no body/query and returns
HTTP 200 `{ files: boolean, history: boolean, terminal: boolean }`. It resolves the
registered project; files/history are false on Windows and terminal reflects service
availability. Missing surface service returns 404 `not_found`.

All operations below are HTTP POST and return HTTP 200. Bodies are closed JSON
objects; all listed fields are required, with optional `taskId` on every operation.
`taskId` is a lowercase UUID v4 selecting that task's conversation workspace and
must belong to this project. Without it the operation uses the registered checkout.

| Exact path | Body | Response |
| --- | --- | --- |
| `/v1/projects/:id/surface/tree` | `{ path: string, offset: number, taskId? }` | `{ entries: [{ name, path, kind }], nextOffset: number | null, truncated: boolean }`; kind is `file`, `directory` or `symlink`. |
| `/v1/projects/:id/surface/read` | `{ path: string, taskId? }` | `{ path, text, version, unavailableReason }`. |
| `/v1/projects/:id/surface/write` | `{ path: string, text: string, expectedVersion: string, taskId? }` | The same file shape, containing saved text and new version. |
| `/v1/projects/:id/surface/history` | `{ offset: number, taskId? }` | `{ commits: [{ id, parents: string[], subject, authorName, authoredAt }], nextOffset: number | null, truncated: boolean }`. Commit fields other than parents are strings. |
| `/v1/projects/:id/surface/commit-files` | `{ commit: string, taskId? }` | `{ files: [{ path, status, oldPath? }], truncated: boolean }`; status is `added`, `modified`, `deleted` or `renamed`. |
| `/v1/projects/:id/surface/commit-diff` | `{ commit: string, path: string, taskId? }` | `{ path, original: { text, truncated }, modified: { text, truncated }, unavailableReason }`. |

Paths are relative, nonempty, at most 4096 UTF-8 bytes, with no backslash or
control character U+0000-U+001F (DEL is accepted), absolute/drive prefix, empty/dot/parent segment or `.git` segment
(case-insensitive). Tree alone accepts `path: ""` for the root. Offsets are safe
integers from 0 through 100,000. Commit IDs are 40 or 64 lowercase hex characters,
reachable ancestors of HEAD. `expectedVersion` is a 64-character lowercase SHA-256
hex digest returned by read. Write text is at most 65,536 UTF-8 bytes with no NUL;
wrong types, NUL or excessive text return 413 `too_large` in this parser.

Tree scans at most 10,000 entries, omits `.git`, and returns at most 200 entries,
directories first then by name. Symlinks are listed but not traversed. File reads
and writes require an existing regular file with one hard link, never follow
symlinks, and bound text to 64 KiB. A readable file returns a SHA-256 `version`
and null `unavailableReason`; binary/invalid UTF-8 or large files return empty text,
null version and `binary` or `large`. Write atomically replaces the existing file
only if the version and file/workspace identity still match; it does not create a
missing file. Concurrent writes to the same workspace/path conflict.

History reads HEAD with 50 commits per page; `authoredAt` is a date string from Git.
Commit files compare the first parent (or the empty tree for a root commit), up to
1,000 files and 256 KiB of serialized file entries. Commit diff uses that listing,
including renamed old paths; each text side is bounded to 64 KiB. If either side
is binary or large, both texts are empty; large sets both side truncation flags.
`unavailableReason` is null, `binary` or `large`.

Errors are 400 `invalid_input` for field/path/offset/hash validation, 404 `not_found`
for missing service/project/task/file or unreachable commit, 409 `conflict` for
unsafe/replaced workspaces, symlinks/hardlinks, stale versions or concurrent saves,
503 `busy` when four surface operations are already active, and 503
`storage_unavailable` for failed file helpers or invalid helper/Git results.
The operation signal has a 15-second budget; the file helper has a 10-second budget.
Unclassified failures use 500 `internal_error`, not a separate surface timeout code.

## Project and conversation terminals

Terminal routes have no client-capability gate and accept optional matching runner
identity. Check `GET /v1/projects/:id/surface/capabilities` for `terminal` support.
All successful terminal commands return HTTP 200.

| Route | Request / response |
| --- | --- |
| `POST /v1/projects/:id/terminals` | Closed `{ cols: number, rows: number, taskId?: string }` -> TerminalSnapshot. No query accepted. |
| `GET /v1/projects/:id/terminals/:terminalId` | Optional `?after=<digits>`, `?taskId=<uuid>`, or both in either order -> TerminalPage. No body. |
| `POST /v1/projects/:id/terminals/:terminalId/input` | Closed `{ data: string }`; optional `?taskId=<uuid>` -> `{ accepted: true }`. |
| `POST /v1/projects/:id/terminals/:terminalId/resize` | Closed `{ cols: number, rows: number }`; optional `?taskId=<uuid>` -> TerminalSnapshot. |
| `DELETE /v1/projects/:id/terminals/:terminalId` | Optional `?taskId=<uuid>`, no body -> `{ closed: true }`. |

Columns are integers 2-500 and rows integers 1-300. Input data is nonempty and at
most 65,536 UTF-8 bytes. Terminal/task IDs are lowercase UUID v4. Opening with a
task selects its conversation workspace; omission selects the project checkout.
Every later request must supply the same task scope (or omit it for a project
terminal), otherwise 404 `not_found`. Unknown/duplicate query fields are rejected
by the exact allowlist. `after` defaults to zero and must be a nonnegative safe
integer no greater than the terminal's current sequence.

TerminalSnapshot is `{ id, projectId, taskId, cols, rows, status, exitCode, sequence }`:
`taskId` and numeric `exitCode` are nullable; status is `running` or `exited`.
TerminalPage adds `{ chunks: [{ sequence: number, data: string }], truncated: boolean }`.
Chunks have strictly increasing sequence numbers. Poll using the last received chunk
sequence, since the snapshot's sequence can be ahead of the returned page.
`truncated` is true when output after the requested cursor was evicted before this
read (the oldest retained chunk is newer than `after + 1`), so the page does not
start immediately after the cursor. It is false when only output at or before the
cursor was evicted, and it never means a page is full. Pages contain at most 256 KiB of chunk data; retention is 1 MiB or 4096
chunks, and each chunk is at most 16 KiB.

Open reuses a running terminal for the exact project/task scope (the existing size
is retained); it does not require an idempotency key. Sessions survive transport
reconnects in memory, expire after 24 hours without activity, and are removed on
close/shutdown. Closing twice returns 404 on the second request. The PTY runs the
fixed `/bin/bash -l` in the selected workspace. Input and resize require a running
session; exited sessions retain bounded readable output until removed/expired.

Errors are 400 `invalid_input` for bad sizes, input or cursor, 404 `not_found` for
missing service/project/task/session or mismatched scope, 409 `conflict` for an
exited session's input/resize or changed workspace, 503 `busy` for session admission
or over 256 KiB input per session per one-second window. After service shutdown,
open returns 503 `storage_unavailable` and every other terminal request returns
404 `not_found`; an unusable PTY descriptor is 503 `storage_unavailable` and other
spawn failures are 500 `internal_error`. Session/opening admission
is bounded by a 16-slot check. Shared JSON/media/boundary errors also apply.

## Project repository identity

`GET /v1/projects/:id/repository-identity` requires the exact `X-Codevo-Runner-Id`,
accepts no body/query and has no client-capability gate. HTTP 200 returns exactly
`{ repositoryKey: string | null }`, derived from the registered checkout's local
`remote.origin.url`. It is a display grouping identity, not workspace authority.

The canonical key is `host[:nondefault-port]/path`: host is lowercase, default
scheme ports, trailing slashes and a final `.git` are removed, and github.com paths
are lowercased. HTTPS, HTTP, SSH, Git and scp-style inputs can be recognized; an
absent, unsupported or uncanonicalizable origin yields null. Raw origin URLs and
credentials are not returned. The lookup pins/revalidates the workspace, admits
at most two concurrent reads and uses a five-second signal deadline.

Missing identity is 409 `conflict`; foreign/duplicate identity follows the shared
boundary rules. Missing execution/identity service or project is 404 `not_found`,
concurrent read exhaustion and execution that is not initialized, is shutting down
or has a failed worker are 503 `busy`; changed workspace can be 409 `conflict`,
and a closed or failed SQLite repository is 503 `storage_unavailable`. Unclassified
lookup/cancellation failures use 500 `internal_error`.

## Text attachments

`PUT /v1/attachments/:id` also accepts exact content type `text/plain`, without
Content-Encoding, using the same required percent-encoded `X-File-Name` and UUID
rules as image uploads. The body is raw, nonempty valid UTF-8 with no NUL and at
most 5 MiB; the upload transport's 8 MiB ceiling still applies. Success is
`{ attachment, created }`, 201 for new or 200 for identical retry.

`GET /v1/attachments/:id` returns text metadata `{ id, runnerId, name, bytes,
sha256, createdAt, mediaType: "text/plain" }`, without image width/height.
`GET /v1/attachments/:id/content` returns the original text bytes with the same
no-store/nosniff and attachment-download behavior as images. These routes accept
optional matching runner identity and have no capability-token gate. The
`textAttachments` discovery boolean advertises support. Draft/continuation/pending
parts reference text files with the existing attachment part shape.

Invalid UTF-8, empty or NUL-containing text is 415 `unsupported_media`; excessive
bytes are 413 `too_large`. Shared attachment errors include 400 `invalid_input`,
404 `not_found`, 409 `conflict` for changed retry bytes/metadata, 429
`quota_exceeded`, 503 `busy`/`storage_unavailable`, and upload timeout 408
`request_timeout`. Text files share the 256-file/256 MiB attachment store and
per-task eight-reference limit with images.

## Additional repository and question contract details

The repository routes in [Project and thread management](#project-and-thread-management)
require the runner identity, but have no client-header capability gate. Hosts,
lookup and search return HTTP 200 for their typed outcomes. Lookup/search bodies
are closed: `provider` is `github` or `gitlab`, `host` is lowercase ASCII matching
`[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?`, at most 253 characters. Lookup `path` is at
most 255 characters with no `..`, exactly two slash-separated segments for GitHub
or 2-20 for GitLab, each matching `[A-Za-z0-9][A-Za-z0-9._-]*`. Search `query` must
already be trimmed (leading or trailing whitespace is 400 `invalid_input`),
1-100 characters matching `[A-Za-z0-9][A-Za-z0-9._ /-]*`, with no `..`;
`page` is an integer 1-10. Invalid bodies are 400 `invalid_input`; absent services
are 404 `not_found`; body/media errors follow the shared rules.

`GET /v1/repositories/hosts` returns `{ github: HostsState, gitlab: HostsState }`.
HostsState is `{ status: "ready", hosts: [{ provider, host, auth }], truncated }`,
where auth is `authenticated` or `notAuthenticated`, or `{ status: "cliMissing" }`,
or `{ status: "failed", reason: "timedOut" | "invalidOutput" | "busy" }`.
Lookup success is `{ status: "ok", repository }`; search success is the shape
already listed. Repository is `{ provider, host, fullPath, description, visibility,
defaultBranch, sshUrl, httpsUrl }`; description (up to 200 code points), branch and
URLs are nullable strings, and visibility is `public`, `private`, `internal` or
`unknown`. Failure outcomes are `{ status }` with `notFound`, `cliMissing`,
`notAuthenticated`, `hostNotAllowed`, `timedOut` or `superseded`;
`{ status: "rateLimited", retryAfterSeconds: number | null }`; or
`{ status: "failed", reason: "network" | "invalidOutput" | "outputTooLarge" | "busy" | "unknown" }`.
These statuses are JSON outcomes rather than HTTP error codes.

`GET /v1/tasks/:id/questions` and
`POST /v1/tasks/:id/questions/:requestId/answer` have no capability-header gate;
runner identity is optional when omitted. Both return HTTP 200 with the shapes
in [Interactive questions](#interactive-questions). Requests contain 1-4 questions,
each with at most 12 options. Question/option identifiers match
`[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`. Header/prompt/option label/description limits
are 128/8192/512/2048 UTF-8 bytes; header and description may be blank. Prompts and
labels are nonblank. All reject NUL. Answers are closed objects containing all
three fields `questionId`, `optionIds`, `text`; text can be empty, up to 8192 UTF-8
bytes, without NUL. Selection IDs cannot duplicate; non-multiple questions accept
at most one. Every question must have a selection or nonblank custom text; custom
text is forbidden when `allowCustom` is false. Invalid answers are 400
`invalid_input`, missing service/task/request 404 `not_found`, stale/different
answers 409 `conflict`; shared JSON/media and storage errors also apply.

## Additional management and Git response details

`POST /v1/project-directories` returns HTTP 200. Its closed body is `{ path? }`;
omission selects the projects root. A supplied path is an absolute string of at
most 4096 UTF-8 bytes without control characters or DEL/C1 controls or a `..`
segment. Invalid input is 400 `invalid_input`, missing service 404 `not_found`,
outside-root, missing or symlink-alias selections are 400 `invalid_input`, four
concurrent listings cause 503 `busy`, and lost directory ownership returns 503
`storage_unavailable`. The
controller aborts after ten seconds; unclassified filesystem/abort errors return
500 `internal_error`. It requires runner identity and has no capability-header gate.

All thread metadata/order successes are HTTP 200. `expectedRevision` is a
nonnegative safe integer. A non-null title must be nonblank without ASCII controls
or DEL. The resulting metadata cannot have both non-null `snoozedUntil` and
`settledAt`. `targetTaskId` is a string matching `[a-zA-Z0-9_-]{1,128}`; the route's
own task ID and the metadata-list `after` cursor are restricted by the boundary
to UUID v4. Invalid input is 400 `invalid_input`, missing task/service 404
`not_found`, stale revision or incompatible reorder 409 `conflict`, and revision,
section or storage capacity exhaustion 429 `quota_exceeded`. All require the
runner identity and have no capability-header gate.

For the Git routes already listed in [Git sync](#git-sync), `dirty` is
`{ tracked: number, untracked: number, truncated: boolean }` with counts 0-10,000.
Project `upstream` and task `published` are nullable
`{ ref: string, ahead: number, behind: number }`. Task `base` is nullable
`{ branch: string, sha: string, fetchedAt: string | null, ahead: number, behind: number }`.
Counts are nonnegative safe integers. Branch fields are nullable where permitted
by their response shape, and `fetchedAt` is a nullable timestamp string.
Project operation state is `none`, `merge`, `rebase`, `cherry-pick`, `revert` or
`bisect`; task mode is `worktree` or `in-place`.

GitOperation status is `running`, `succeeded` or `failed`. Running has null
`error` and `result`; failed has a Git error code and null result; succeeded has
null error and a kind-specific result:

| Kind | Result |
| --- | --- |
| `fetch` | `{ kind: "fetch", fetchedAt: string }` |
| `update` | `{ kind: "update", headSha: string, fastForwarded: number }` |
| `push` | `{ kind: "push", remoteRef: string, pushedSha: string, created: boolean }` |

`remoteRef` begins `refs/heads/`; `fastForwarded` is a nonnegative safe integer.
Fetch/update/push keys are lowercase UUID v4. These routes require runner identity;
`gitSync` only gates discovery, not requests. Read successes and commit are HTTP
200; fetch/update/push admission is 202, including idempotent job retries.

## Additional pending and artifact errors

Pending routes accept optional matching runner identity and have no capability
header gate. GET, DELETE and resume successes are HTTP 200; enqueue returns 202
or 200 as described above. In addition to enqueue's shared message/launch/instruction
validation, missing task/message/service is 404 `not_found`, changed retry input,
dispatched-message removal or unavailable resume is 409 `conflict`. Every pending
route except DELETE also returns 409 `conflict` for a task that was never started
(a draft or project-less task). Capacity exhaustion is 429 `quota_exceeded`,
execution starting, stopping or failed is 503 `busy`, and unavailable storage is
503 `storage_unavailable`. Resume and removal accept no body.

Artifact routes likewise have no capability-header gate and accept optional matching
runner identity. Capture's closed `{ path: string }` body permits at most 4096 UTF-8
bytes, rejects backslashes, control characters U+0000-U+001F (DEL is accepted),
URI scheme prefixes and `..`/`.git`
segments, and supports the extensions `.png`, `.jpg`, `.jpeg`, `.webp`, `.html`,
`.htm` (case-insensitive). Malformed paths are 400 `invalid_input`; unsupported
media is 415 `unsupported_media`; missing service/task/file/snapshot is 404
`not_found`; active or obsolete uncaptured turns and unsafe sources conflict with
409 `conflict`; file bounds are 413 `too_large`, store limits 429
`quota_exceeded`, concurrent admission 503 `busy`, and storage failure 503
`storage_unavailable`. List and content successes are HTTP 200; capture is 201 or
200 as already described.

## Command catalog

Clients announcing `commandCatalog` in `X-Codevo-Client-Capabilities` discover the
optional `commandCatalog` capability. It is true when execution is enabled and tasks
launch the provider CLIs; otherwise it is false and the route returns 404.
Authentication, runner identity, exact paths and query-string rules match Git sync;
only GET is allowed.

| Route | Response |
| --- | --- |
| `GET /v1/projects/:projectId/command-catalog/:provider` | `{version:1,provider,truncated,entries:[{kind,name,label,description,argumentHint,builtin}]}` |

`:provider` is `claude` (response `provider` is `claudeCode`, every entry has `kind`
`command`) or `codex` (`provider` is `codex`, every entry has `kind` `skill`). An
unknown project or provider is 404 `not_found`. The object is closed: no other
fields are returned, and `label`, `description` and `argumentHint` are always present
as a string or `null`.

The catalog is what a task of that project would see: the runner starts the same
provider executable with the same environment allowlist as a task launch, in the
registered checkout, pinned by directory identity before exec. Claude Code is asked
for its `initialize` control response with hooks, session persistence and MCP servers
disabled, so slash commands contributed by MCP servers are not listed. Codex is
asked for `skills/list` of the checkout through `codex app-server`, and only the
single listing for exactly that directory is used: a reply without it, or with it
more than once, fails the read instead of returning another directory's skills.
Neither probe sends a prompt. Only command and skill names, labels, descriptions and argument hints
are read; account data, model lists and skill file paths are never returned or
logged. Task worktrees are not probed separately, so a command file that differs in
a conversation worktree is reported as it exists in the registered checkout.

Names match `^[A-Za-z0-9][A-Za-z0-9:_.-]*$` and are at most 128 bytes; entries with
any other name, including provider-internal names starting with `__`, disabled Codex
skills and repeated names (the first wins) are omitted. Text fields are trimmed,
whitespace and control characters collapse to single spaces, an empty value becomes
`null`, and longer values are cut on a code point boundary to 128 UTF-8 bytes
(`label`, `argumentHint`) or 512 (`description`). At most 512 entries are returned in
provider order; `truncated` is true when more valid entries existed, and also when
Codex reports skills that failed to load (the failure text and paths are not
returned). `builtin` marks CLI built-in commands and Codex `system` skills.

A Codex read can take a few seconds. Codex loads user and plugin skills
asynchronously after startup and gives no completion signal, so the runner polls
`skills/list` inside one app-server process: one request at a time, re-sent every
400 ms, until the ordered list of names has been unchanged for 2 seconds or 6
seconds have passed since the handshake, whichever comes first. The latest listing
is returned. A skill that appears later than that is picked up by the next refresh.

A probe is bounded to 5 seconds of checkout validation and 20 seconds for Claude Code
or 15 seconds for Codex. Claude Code output is bounded to 2 MiB; each Codex reply
line is bounded to 2 MiB and all Codex output of one probe to 16 MiB, with earlier
polls released once parsed. Exceeding any of these, a non-zero exit, an error or
invalid reply or a checkout that fails validation is 503 `storage_unavailable` and
the whole process tree is killed. Output over the cap is never served as a shortened catalog. A catalog is
cached per project and provider for 60 seconds and concurrent reads of one key share
one probe. When a refresh fails, the last good catalog of that key is served until
it is 10 minutes old; a failure is never cached. At most 32 keys are cached (the
oldest fetch is evicted first) and at most two probes run runner-wide: a further key
is answered from its last good catalog or refused immediately with 503 `busy`.
Shutdown aborts running probes.

## MCP servers

Clients announcing `mcpServers` in `X-Codevo-Client-Capabilities` discover the
optional `mcpServers` capability. It is true under the same condition as
`commandCatalog`: execution is enabled and tasks launch the provider CLIs; otherwise
it is false and the route returns 404. Authentication, runner identity, exact paths
and query-string rules match the command catalog; only GET is allowed and a body is
refused.

| Route | Response |
| --- | --- |
| `GET /v1/projects/:projectId/mcp-servers/:provider` | `{version:1,provider,truncated,servers:[{name,status,scope,transport,endpointOrigin,toolCount,detail}]}` |

`:provider` is `claude` or `codex` and is echoed as `provider`. An unknown project or
provider is 404 `not_found`. The object is closed: no other fields are returned and
every server field is always present.

| Field | Values |
| --- | --- |
| `status` | `connected`, `connecting`, `needsAuth`, `failed`, `disabled`, `unknown` |
| `scope` | `user`, `project`, `local`, `account`, `plugin`, `managed`, `unknown` |
| `transport` | `stdio`, `http`, `sse`, `unknown` |
| `endpointOrigin` | `scheme://host[:port]` of an HTTP(S) endpoint, at most 256 bytes, or `null`; always `null` for `stdio` |
| `toolCount` | number of tools when the provider reported them and there are at most 4096, otherwise `null` |
| `detail` | redacted single-line failure text of at most 256 bytes, only for `failed`, otherwise `null` |

Every request runs one fresh check; nothing is cached and nothing polls in the
background. The runner starts the same provider executable with the same environment
allowlist as a task launch, in the registered checkout, pinned by directory identity
before exec. This starts the MCP servers the provider would start for a task of that
project, including servers configured by the project itself, so the route is offered
only where tasks may execute. No prompt or user message is ever sent.

Claude Code is started in print mode with hooks and session persistence disabled and
receives only two constant control requests: `initialize` once, then `mcp_status`
every 500 ms. The first answers can be empty or incomplete, so polling continues
until the list has been unchanged for 2 seconds, a later poll confirmed it and no
server is still pending; 20 seconds after `initialize` was answered, after 48 polls
or 25 seconds after the process started the latest list is returned with pending
servers reported as `connecting`.

Codex is asked through `codex app-server`: `initialize`, then `initialized` and one
`mcpServerStatus/list`, which answers when every server finished starting. A Codex
reply with a further page sets `truncated`. Only after that list arrived the runner
sends one `config/read` for the checkout and waits at most 5 seconds for its answer.
From the configuration only `mcp_servers.<name>.enabled` is read: a listed server
that is disabled there becomes `disabled` with `detail` `null`, unless the list
reports it as `connected` or `connecting`. The configuration read can only refine the
list: when it times out, is answered with an error or an unusable result, exceeds the
line bound, or the process exits or stops reading first, the status list is returned
unchanged.

Names are at most 128 bytes without control characters, surrounding whitespace or
bidirectional controls and are unique; other entries are omitted and set
`truncated`, as do more than 128 servers. Servers are sorted by name in byte order.
Commands, arguments, environment, headers, URL credentials, paths, queries and
fragments, tool names and schemas, server info, identifiers and process ids are never
returned or logged. `detail` keeps ordinary words; option-like words and the word
after them, words containing `/`, `\`, `=` or `@`, and long token-like runs become
`[redacted]`, and URLs are reduced to their HTTP(S) origin or redacted.

A check is bounded to 5 seconds of checkout validation and 25 seconds of provider
run time. At 25 seconds Claude Code's latest list is returned if one arrived and
its process is killed no later than 26 seconds after start; the Codex process is
killed at 25 seconds and its status list is returned if it had already arrived.
Claude Code output is bounded to 2 MiB per line and 16 MiB in total, Codex output to
8 MiB per line and 16 MiB in total. Without a list, exceeding an output bound, a
non-zero exit, an error or invalid reply, a timeout or a checkout that fails
validation is 503 `storage_unavailable`; the runner has no separate timeout code.
For Claude Code an output bound, error reply or exit is 503 even after a list
arrived. At most two checks run runner-wide and a further request is refused
immediately with 503 `busy`. The whole provider process tree is killed when the
check completes, fails, times out, the client disconnects or the runner shuts down.

## Speech transcription

Optional. The runner forwards one short audio clip to a speech-to-text HTTP sidecar
on the same host and returns its text. It is enabled only when `CODEVO_SPEECH_URL`
is set to a bare loopback origin: scheme `http://`, a loopback IP literal as host
(`127.0.0.0/8` in canonical dotted form, or `[::1]`), an optional port, and no path
other than a single `/`, no query, fragment or user information, for example
`http://127.0.0.1:8001`. Host names such as `localhost`, `https://` and any other
value fail startup. When the variable is unset the feature is absent.

Clients announcing `speechTranscription` in `X-Codevo-Client-Capabilities` discover
the `speechTranscription` capability: true when the sidecar URL is configured, false
otherwise. Other clients receive the unchanged older descriptor without that field.

`POST /v1/speech/transcriptions?language=<sk|en|cs>` requires bearer authentication
and the exact `X-Codevo-Runner-Id`. The `language` query is required and exact: a
missing, repeated, percent-encoded or additional parameter is 404, and any other
method is 405.

- Request: `Content-Type: application/octet-stream` without parameters and no
  `Content-Encoding`. The body is raw signed PCM16 little-endian, mono, 16,000 Hz,
  from 640 to 960,000 bytes inclusive (20 ms to 30 s) with an even byte count.
- Response: `200 {"text": string}`. The text is trimmed, holds at most 4,000
  characters and is `""` for silence.

| Status and error | Cause |
| --- | --- |
| 409 `runner_identity_mismatch` | Missing or foreign `X-Codevo-Runner-Id` |
| 404 `not_found` | `CODEVO_SPEECH_URL` is not configured |
| 415 `unsupported_media` | Another content type, or any `Content-Encoding` |
| 413 `too_large` | More than 960,000 bytes, declared or received |
| 400 `invalid_input` | Fewer than 640 bytes, or an odd byte count |
| 503 `busy` | Admission is full, or the deadline passed before the clip reached the sidecar |
| 503 `speech_unavailable` | The sidecar is unreachable, timed out, answered anything but a valid 200, or the runner is shutting down |

Checks run in that order, except that admission is decided after the declared
`Content-Length` is checked and before the body is buffered, so a full runner never
holds a refused clip in memory.

The runner sends `POST {CODEVO_SPEECH_URL}/transcribe?language=<language>` with
`Content-Type: application/octet-stream` and the identical bytes. The only accepted
answer is status 200 with a JSON object whose single field is `text`, a string of at
most 4,000 characters, in a body of at most 32,768 bytes. Any other status
(redirects are not followed), field, type, encoding or size is `speech_unavailable`.

Admission is runner-wide: one sidecar request is in flight and at most four further
requests wait, served in the order their uploads complete; a sixth concurrent
request is refused with `busy`.
Each admitted request has one 30-second deadline covering its upload, its wait and
the sidecar call. A request that has not been forwarded by then answers `busy`; one
that is waiting for the sidecar answers `speech_unavailable`. A client disconnect or
runner shutdown aborts the sidecar request and releases the slot immediately.

A request refused at admission (`busy`, or `speech_unavailable` during shutdown) is
answered only after its body has been read and discarded, so the JSON error reaches
a client that is still uploading instead of a connection reset. Discarding stops at
960,000 bytes or after 5 seconds, whichever comes first; a body beyond either bound
is answered at once and may be cut off. A discarded body holds no admission slot.

Audio and transcript text exist only in memory for the duration of the request.
They are never written to the data directory and never logged.
