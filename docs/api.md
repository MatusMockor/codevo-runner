# Draft and attachment API (protocol version 1)

The runner stores drafts. Selecting `codex` or `claude` records intent only: it does
not start a CLI, authenticate a provider, edit a project or run tests.

Every route below requires `Authorization: Bearer <token>`. The only public route
is `GET /healthz`. Requests with an Origin header are rejected. Paths are exact;
unsupported query parameters and trailing-slash aliases are not accepted.

| Request | Response |
| --- | --- |
| `GET /v1/runner` | Identity and advertised capabilities |
| `POST /v1/tasks` | `{ task, created }`, 201 for new or 200 for identical retry |
| `GET /v1/tasks?after=0` | `{ items, nextCursor }` in ascending creation sequence |
| `GET /v1/tasks/:id` | Task |
| `POST /v1/tasks/:id/cancel` | Task with `status: "cancelled"`; no request body |
| `GET /v1/tasks/:id/events?after=0` | `{ items, nextCursor }` containing task events |
| `PUT /v1/attachments/:id` | `{ attachment, created }`, 201 for new or 200 for retry |
| `GET /v1/attachments/:id` | Attachment metadata |
| `GET /v1/attachments/:id/content` | Original validated image bytes |

Task status is `draft` or `cancelled`. Events are `task.created` and `task.cancelled`.
Repeated cancellation returns the cancelled task without adding another event.
Pages contain at most 50 items. `after` is an exclusive, nonnegative integer cursor;
`nextCursor` is null when that response has no further page. For continued event
polling, retain the largest event `sequence` received even when `nextCursor` is null.
Task-list cursors enumerate creation, not changes to previously listed tasks.
There is no SSE connection or automatic event subscription.

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

Copy the returned task ID into `TASK_ID` to inspect or cancel the draft:

```sh
TASK_ID=replace-with-returned-task-id
curl --fail-with-body "$RUNNER_URL/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
curl --fail-with-body "$RUNNER_URL/v1/tasks/$TASK_ID/events?after=0" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
curl --fail-with-body -X POST "$RUNNER_URL/v1/tasks/$TASK_ID/cancel" \
  -H "Authorization: Bearer $RUNNER_TOKEN"
```

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
