# Remote approvals (protocol version 1)

A running agent sometimes asks for permission before it runs a command, changes a
file, uses a tool or leaves plan mode. Remote approvals let an authenticated client
(mobile app, desktop editor) see that request and answer it while the provider
process keeps waiting.

The feature is opt-in per turn. A client that never announces the capability sees
exactly the behaviour and the JSON it saw before this feature existed.

## Capability and opt-in

The capability name is `interactiveApprovals`. A client announces it in the request
header `X-Codevo-Client-Capabilities` (a comma-separated list, as for the other
optional capabilities).

| Request | Effect of announcing `interactiveApprovals` |
| --- | --- |
| `GET /v1/runner` | `capabilities.interactiveApprovals` is present: `true` when execution is enabled, `false` otherwise. Without the header the key is absent. |
| `POST /v1/tasks/:id/start` | The started turn asks for approvals. |
| `POST /v1/tasks/:id/continue` | The continued turn asks for approvals. |
| `POST /v1/tasks/:id/pending` | The task this queued message later creates asks for approvals. |
| `GET /v1/tasks/:id`, `GET /v1/tasks` | A task with a pending approval carries `"awaiting": "approval"`. |

The opt-in is taken from the request that admits the turn and stored with that turn.
It is not inherited: a continuation or a queued followup uses the header of its own
request, not the header of the task it continues. A repeated `start` of an already
started task does not change the stored choice. A queued message that is steered into
the turn that is already running follows that running turn.

Why the gate keys on the admitting request: readers are anonymous per request, so the
runner cannot know who is watching a task. The client that starts the turn has asked
for interactive behaviour and is the one expected to answer. Every approval also
expires after 10 minutes, so a client that disappears cannot hang a turn. Any client
holding the bearer token may answer, as with questions.

A turn admitted without the capability runs exactly as before: Claude permission
requests are denied automatically and Codex runs with approval policy `never`.

## Routes

Both routes require `Authorization: Bearer <token>`. Paths are exact, query strings
are not accepted, and a request with an `Origin` header is rejected. Task and request
ids are UUIDs; any other path segment does not match a route and returns 404.

### `GET /v1/tasks/:taskId/approvals`

Returns 200 with the approvals of one task in creation order, at most 48 items.

```json
{ "items": [ {
  "id": "3f2a9c1e-5b7d-4f0e-9a1b-2c3d4e5f6a7b",
  "taskId": "8c0d1f5e-2a3b-4c4d-9e5f-6a7b8c9d0e1f",
  "provider": "claudeCode",
  "kind": "command",
  "title": "Run a command?",
  "detail": "npm test",
  "detailTruncated": false,
  "facts": [ { "label": "Tool", "value": "Bash" }, { "label": "Purpose", "value": "Run the test suite" } ],
  "decisions": [ "allowOnce", "allowForSession", "deny" ],
  "status": "pending",
  "expiresAt": "2026-10-06T12:10:00.000Z"
} ] }
```

A request settled by an answer adds `decision`:
`{ ..., "status": "approved", "decision": "allowOnce" }` or
`{ ..., "status": "denied", "decision": "deny" }`. Requests in any other status have
no `decision` key.

| Field | Meaning |
| --- | --- |
| `id` | Runner-generated UUID of this request. |
| `taskId` | The task that owns the request. |
| `provider` | `codex` or `claudeCode`. |
| `kind` | `command`, `fileChange`, `tool` or `plan`. |
| `title` | One-line question, at most 256 bytes. |
| `detail` | What is being approved (command text, file body, plan, tool input), at most 16 KiB. May be empty. |
| `detailTruncated` | `true` when `detail` was shortened or cleaned and is not the exact provider text. |
| `facts` | Up to 8 `{ label, value }` pairs (label at most 64 bytes, value at most 2048 bytes). |
| `decisions` | The decisions this request accepts. Always contains `deny`. |
| `status` | `pending`, `approved`, `denied`, `cancelled`, `expired` or `timedOut`. |
| `expiresAt` | ISO 8601 UTC time at which a pending request times out. Kept unchanged after the request settles. |
| `decision` | Present only for `approved` (`allowOnce` or `allowForSession`) and `denied` (`deny`). |

All four enums are closed. Treat an unknown value as an error, not as a new variant.

### `POST /v1/tasks/:taskId/approvals/:requestId/answer`

The body is a JSON object with exactly one key and is limited to 4096 bytes.

```json
{ "decision": "allowOnce" }
```

Returns 200 with `{ "request": { ...the settled request... } }`. `decision` must be
one of the values listed in that request's `decisions`.

Posting the same decision again on a request that this decision already settled
returns 200 with the same body, so a client may safely retry after a lost response.

### Errors

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `invalid_input` | Malformed JSON, a body that is not an object, unknown or missing keys, a decision that is not a known value, a decision that is not in the request's `decisions`. |
| 400 | `body_not_allowed` | A body on the GET route. |
| 401 | `unauthorized` | Missing or invalid token. |
| 403 | `origin_not_allowed` | An `Origin` header is present. |
| 404 | `not_found` | Unknown task, unknown request id for that task (this covers answering through another task's path), a path whose ids are not UUIDs, a query string, or a runner without execution. |
| 405 | `method_not_allowed` | Wrong method. |
| 409 | `conflict` | The request is no longer pending (`cancelled`, `expired`, `timedOut`, or settled with a different decision), the task is not running, or no live provider process is waiting for the answer (for example after a runner restart). |
| 413 | `too_large` | Body over 4096 bytes. |
| 415 | `unsupported_media` | Content type is not `application/json`, or a content encoding is used. |
| 429 | `quota_exceeded` | Host storage is too low to record the answer. |
| 503 | `busy` / `storage_unavailable` | As on the other routes. |

### Task field

```json
{ "id": "8c0d1f5e-2a3b-4c4d-9e5f-6a7b8c9d0e1f", "status": "running", "awaiting": "approval" }
```

`awaiting` is derived on every read from the pending approvals of the task. It is
never stored with the task, there is no new task status, and the key is omitted when
nothing is pending or when the reading client did not announce the capability.

## Limits

| Limit | Value |
| --- | --- |
| Pending approvals per task | 16. A further provider request is denied without being shown. |
| Settled approvals kept per task | 32. Creating a new approval first removes the oldest settled ones beyond the newest 32; a pending approval is never removed. |
| Items returned by the list route | 48 |
| Waiting approvals runner-wide | 1024 (64 active tasks x 16) |
| `title` | 256 bytes |
| `detail` | 16 KiB, flagged by `detailTruncated` |
| `facts` | 8 entries, label 64 bytes, value 2048 bytes |
| Stored approval JSON per task | 2 MiB. When a new approval does not fit, the oldest settled ones are removed until it does; if only pending approvals remain and it still does not fit, the provider request is denied without being shown. |
| Answer body | 4096 bytes |
| Time to answer | 600 000 ms, then the request becomes `timedOut`, the action is not allowed, and the provider is told that no decision was received |

Because old settled requests are removed, an idempotent retry returns 404 once its
request has been removed: after 32 later settled approvals of the same task, or
earlier when large approvals fill the 2 MiB budget.

## Lifecycle

```
pending -- answer allowOnce / allowForSession --> approved
pending -- answer deny -------------------------> denied
pending -- 600 s without an answer -------------> timedOut   (action not allowed)
pending -- cancel ------------------------------> cancelled
pending -- expire ------------------------------> expired
```

- `cancelled`: the task was stopped with `POST /v1/tasks/:id/cancel`, the provider
  withdrew the request, or the provider turn or process ended while the request was
  still pending.
- `expired`: the task finished or failed with the request still recorded as pending,
  or the runner restarted. A restarted runner has no provider process to resume, so a
  request it finds pending is expired at startup.

Every status other than `pending` is final. Each transition is a single conditional
update, so an answer that races a timeout, a stop or a provider cancellation has
exactly one winner and the loser gets 409. An answer is delivered at most once, and
only to the provider invocation that asked.

A provider that withdraws an approval does not fail the turn; the turn's own result
decides the outcome. Sending a steering message is refused while an approval of that
task is pending.

Only an answer posted by a client is reported to the agent as a user decision. When
no decision arrives (the request timed out, or the runner could not record or deliver
it because of a limit or a storage failure) the action is not allowed and the agent is
told exactly that: no decision was received. It is not told that the user refused.

## Decisions

- `allowOnce` - allow this one action.
- `allowForSession` - allow this action and matching later ones for the rest of the
  current provider process, which is the current turn. A continued turn starts a new
  process and asks again. Offered only when the provider can express such a grant.
- `deny` - refuse. The agent continues the turn and is told the user denied the action.

## Provider behaviour

### Claude

Claude asks through its permission prompt. The runner turns each request into an
approval, except reads of text attachments staged for the task (still allowed
automatically) and `AskUserQuestion` (served by the questions API).

| Tool | `kind` | `title` | `detail` |
| --- | --- | --- | --- |
| `ExitPlanMode` | `plan` | `Approve the plan?` | the plan |
| `Bash` | `command` | `Run a command?` | the command |
| `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | `fileChange` | `Allow <tool> to change a file?` | the new content |
| any other tool | `tool` | `Allow <tool>?` | the tool input as JSON |

A title supplied by Claude replaces the default one. Facts, when available: `Tool`,
`File`, `Purpose`, `Blocked path`, `Reason`, `Details`, and `Session approval covers`
(the rules an `allowForSession` answer would add).

`allowForSession` is offered only when Claude itself suggests allow rules for the same
tool, and never for `ExitPlanMode`. The `Session approval covers` fact lists every rule
the answer would add, and exactly those rules are sent to Claude. The option is
withheld when that cannot be guaranteed: more than 16 suggestions or more than 16
rules, a same-tool rule the runner cannot validate (rule text over 1024 bytes or
containing a line break or another control character, for example), or a rule list
that does not fit the 2048-byte fact. The runner never grants
a subset of what Claude suggested.

Denying a plan tells Claude that the user wants to keep planning. A plan approval that
times out tells Claude only that no decision was received and that plan mode stays
active.

A request the runner cannot describe safely (a tool name over 128 bytes, `Bash`
without a command, input that is not an object) is denied without creating an
approval.

Which requests appear depends on the launch mode chosen for the task:

| Launch mode | Requests surfaced as approvals |
| --- | --- |
| none or `default` | tools outside the built-in allowlist (for example WebFetch, MCP tools, NotebookEdit) |
| `plan` | `ExitPlanMode` and tools that plan mode blocks |
| `supervised` | every Bash, Edit, Write, MultiEdit, NotebookEdit, WebFetch and MCP use not already allowed by settings |
| `acceptEdits` | Bash, WebFetch, MCP and other non-edit tools |
| `auto` | whatever the automatic classifier escalates |
| `bypassPermissions` | none |

### Codex

Codex asks through app-server approval requests. The runner selects the approval
policy from the launch mode; the sandbox is unchanged. For a turn that asks for
approvals the runner also sends `approvalsReviewer: "user"` on `thread/start`,
`thread/resume` and `turn/start`, so a host configured for automatic review cannot
answer in place of the remote client. A turn admitted without the capability sends
neither a changed policy nor that field.

| Launch mode | Approval policy | Requests surfaced as approvals |
| --- | --- | --- |
| none or `default` | `never` | none |
| `readOnly` | `never` | none |
| `workspaceWrite` | `untrusted` | commands outside Codex's trusted list, file changes outside the writable roots |
| `auto` | `on-request` | escalations the model requests (network, writes outside the workspace, sandbox failures) |
| `dangerFullAccess` | `never` | none |

| Request | `kind` | `title` | `detail` |
| --- | --- | --- | --- |
| command | `command` | `Run a command?` | the command |
| command with a network context | `command` | `Allow network access?` | the command, possibly empty |
| input to a running command | `command` | `Send input to a running command?` | the input, or the command it belongs to |
| file change | `fileChange` | `Apply file changes?` | up to 20 changed paths, then `+N more`, then a blank line and an excerpt of each file's diff headed by `<path>:` |

Facts, when available: `Directory`, `Reason`, `Network host`, `Additional permissions`,
`Action`, `Files` (only to say that Codex did not list the files) and
`Write access requested for`.

`allowForSession` is offered unless Codex lists the available decisions and leaves it
out. For a file change it also requires that every changed path is shown in `detail`,
because the grant covers later changes to the same files: it is withheld when Codex
did not announce the files, when there are more than 20, or when a path is missing,
had to be shortened, or contains a line break or another control character. Such a
path is not rendered; it is counted in `+N more` so the list stays one line per file.
The option is also withheld when the `Network host` or `Write access requested for`
value contains a control character or does not fit its fact, since those values
describe what a session grant covers. Diff excerpts share the 16 KiB `detail` budget in file order;
`detailTruncated` is `true` whenever a path or any part of a diff is left out.

A Codex approval that receives no decision is declined. The app-server reply has no
message field, so Codex sees it as a decline. Requests from another thread or an earlier turn, including subagent threads, and
command requests that name neither a command nor a network host are declined without
creating an approval. Permission-profile requests and MCP elicitations are declined.

## Client guidance

1. Send `X-Codevo-Client-Capabilities: interactiveApprovals` on `GET /v1/runner` and
   continue only when `capabilities.interactiveApprovals` is `true`.
2. Send the same header on every `start`, `continue` and `pending` request whose turn
   should ask, and on task reads so that `awaiting` is included.
3. After a `changed` notification on `/v1/changes`, or on a polling interval, reload
   the task. When it carries `"awaiting": "approval"`, fetch
   `GET /v1/tasks/:taskId/approvals` and show the items whose status is `pending`.
4. Offer exactly the entries of `decisions`. Show `title`, `detail` and `facts`, and
   say so when `detailTruncated` is `true`.
5. Post the answer. On a lost response, post the same decision again. On 409, reload
   the list: the request was settled another way.
6. Closing the client does not cancel a pending approval. Reconnect and fetch the list
   again before `expiresAt`.
