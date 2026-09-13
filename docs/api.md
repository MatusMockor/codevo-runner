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
| `POST /v1/projects/clone` | Clone job, HTTP 202; body `{ idempotencyKey, url, name, branch? }` |
| `GET /v1/project-clones/:id` | Clone job |
| `POST /v1/project-clones/:id/cancel` | Cancel clone job; no request body |
| `POST /v1/tasks/:id/start` | Task, HTTP 202; body `{ "projectId": "my-app" }` |
| `GET /v1/tasks/:id/resume` | Continuation eligibility `{ available, reason }` |
| `POST /v1/tasks/:id/continue` | `{ task, created }`, 202 for new or 200 for identical retry |
| `GET /v1/tasks/:id/diff` | `{ patch, truncated, untrackedFiles }` |
| `GET /v1/tasks/:id/files` | Bounded changed-file list `{ files, truncated }` |
| `POST /v1/tasks/:id/file-diff` | Original and current text for one changed relative path |
| `GET /v1/tasks/:id/events?after=0` | `{ items, nextCursor }` containing task events |
| `PUT /v1/attachments/:id` | `{ attachment, created }`, 201 for new or 200 for retry |
| `GET /v1/attachments/:id` | Attachment metadata |
| `GET /v1/attachments/:id/content` | Original validated image bytes |

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

The body accepts only the four documented fields. `idempotencyKey` is a lowercase
UUID v4. `name` is also the destination folder name: 1–64 ASCII letters, digits,
underscores or hyphens, starting with a letter or digit. `branch` is optional and
must be a valid bounded branch name (at most 255 characters); omitting it clones
the default branch. URLs are at most 2,048 characters and accept the supported
HTTPS, `ssh://user@host/path` or `user@host:path` forms. Credentials in HTTPS URLs,
query strings, fragments, local paths and other protocols are rejected.

HTTPS is anonymous: credential helpers and interactive prompts are disabled.
For private repositories, configure SSH authentication and known host keys under
the runner's service account. The runner does not accept credentials or forward
the desktop SSH agent. The clone destination is selected by the operator's
`CODEVO_PROJECTS_ROOT` (default `~/Developer`), never a client-supplied path.
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
separators or control characters. Upload content type is exactly `image/png` or
`image/jpeg`; the binary body must match and decode as a supported single image.
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

Start accepts exactly `projectId`, never paths, clone URLs, executable names or
shell commands. Admission is persisted before the response. Retrying the same task
and project does not launch it twice; choosing another project conflicts. Terminal
tasks are not restarted. Provider installation and authentication happen on the
host, not through this API; a missing or unauthenticated CLI can fail execution.
The project list exposes IDs and names, not host paths.

After disconnecting, poll events with the largest received sequence to replay
missed output. Output is bounded to 1 MiB and 1,024 output events per task, with
at most 8 KiB per output event. Across the runner, retained output is capped at
8 MiB and 8,192 output events. Exhausting persisted-output capacity stops the
provider and fails the task with `output_persistence_failed`; it does not silently
discard continued output and report success. The process output limit also stops
an excessively verbose CLI. Execution defaults to a 30-minute
timeout. SQLite reserves 16 MiB of headroom for state transitions; exhausted
admission capacity returns a quota error. This is persisted CLI stdout/stderr, not a parsed
provider conversation. There is no live SSE or approval interaction API.
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
metadata and a usable original Git worktree. This check does not query the provider's
history store or prove login readiness. Missing, expired or rejected provider
history can still fail execution. The runner does not fall back to a new session.

Upload any new images before submitting their references. The continuation body
contains exactly `idempotencyKey` and `parts`, with the same UUID, message-part,
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
all turns share the original worktree and baseline. Only the latest turn can admit
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
session metadata and worktree remain available.

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
| Task JSON body | 65,536 bytes |
| Combined prompt text | 48,000 UTF-8 bytes |
| Ordered parts / distinct attachments per draft | 16 / 8 |
| One uploaded image | 8 MiB |
| Image dimension / total pixels | 8,192 per side / 16,000,000 pixels |
| Image metadata aggregate | 256 KiB, counting encoded and inflated PNG metadata |
| Inflated compressed PNG metadata chunk | 64 KiB |
| PNG chunks / JPEG markers | 1,024 |
| Stored attachments / aggregate image bytes | 256 / 256 MiB |
| Stored tasks | 1,000 |
| Concurrent uploads / upload deadline | 2 / 30 seconds |
| Concurrent attachment-store reads (metadata and content combined) | 2 |
| Concurrent HTTP image downloads | 2, held until response finish/close |
| Task or event page | 50 items |

Unsupported image structures or metadata fail closed; a PNG/JPEG extension alone
does not guarantee acceptance. Quotas are runner-wide, not per user. The attachment-store read limit covers file/metadata
retrieval until bytes are returned to HTTP. A separate HTTP download limit remains
held until the response finishes or closes, including slow clients.
HTTP transport can terminate stalled requests
earlier than the attachment deadline. There is no automatic eviction of retained
records; task cancellation does not delete attachments or release storage quota.
Do not manually delete database rows/files to work around quotas.

Error bodies use `{ "error": "code" }`: invalid input is 400, missing records 404,
conflicting retries 409, oversized payloads 413, unsupported media 415, exhausted
quotas 429, and busy/unavailable storage 503. Authentication failures are 401;
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
