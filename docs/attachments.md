# Images, screenshots and attachments

Status: design requirements, not implemented. The current discovery-only API does
not accept uploads. Add attachments with initial task admission, not as a later
text-only protocol retrofit.

## User workflow

The editor must support clipboard image paste, drag and drop, and file selection.
Show thumbnails, upload progress, failure/retry and removal before submission.
Screenshots are image attachments; no separate transport is needed.

A message contains an ordered list of text and attachment references. Preserve
this structure for initial prompts, follow-up messages and restored history.
Changing the execution target invalidates destination upload references: upload
the local source to the new runner before submission. Never route by filename or
by an absolute path from the client machine.

## Upload and task ownership

Upload binary content separately from task commands and event history. An
attachment reference contains an opaque runner-scoped ID, a display name, validated
media type, byte count and integrity digest. The server owns storage paths; client
filenames are display metadata only. IDs and digests are not access credentials.

Use a bounded authenticated streaming upload with explicit completion. Store in a
temporary location, validate content, flush it durably, then atomically finalize it.
A task may reference only complete immutable attachments owned by the same
principal and runner. Persist message references and task admission together;
reject missing, foreign, expired or incomplete references before starting work.

The editor may report a remote task accepted only after the runner has durably
stored both its attachment references and task intent. After that acknowledgment,
the task must not depend on the client or its clipboard/files remaining available.
Retrying an uncertain upload or task admission must not duplicate accepted work.

Store content on persistent runner storage, including when running in Docker.
Keep attachments while retained conversations/tasks reference them. Garbage collect
abandoned uploads and unreferenced content using explicit retention rules, without
racing active uploads, provider reads or task admission. Report missing/corrupted
content truthfully after recovery. Quotas apply to retained bytes as well as uploads.

## Provider and execution boundary

Provider adapters advertise supported input types. Initially target validated PNG
and JPEG images; other formats and document types remain unsupported until an
adapter explicitly handles them. Do not infer support from a model name alone.

Translate attachments into the provider's documented image/file input mechanism.
A mention of a screenshot filename in a text prompt is not image delivery. Verify
actual provider support when implementing each adapter; do not assume Codex and
Claude accept identical payloads or formats.

Materialize read-only task-scoped files when a provider requires paths, including
inside its execution container. Keep those files available for the provider's
actual read lifetime. Never silently drop an unsupported attachment or fall back
to text-only execution; explain the incompatibility before submission.

## Limits and access

Choose and publish concrete maximums before enabling uploads: per-file bytes,
per-message bytes and count, image dimensions/decoded pixels, principal storage
quota, concurrent uploads, read buffers, upload deadlines and temporary retention.
Enforce limits while streaming, not only after allocating the complete file.
Validate file content against the claimed type; extensions and MIME headers are
not proof. Bound image decoding and thumbnail generation separately.

All upload, download, preview and delete operations require authentication and
ownership checks. Serve only supported media safely, never executable client
filenames or arbitrary server paths. Keep binary bodies and credentials out of
logs and events. History streams metadata and retrieves previews on demand rather
than replaying base64 blobs. Images and documents are untrusted task input, not
instructions with authority over the runner or its permission policy.

## Required verification

- Paste/drop/select an image, submit remotely, disconnect, and restore its preview.
- Confirm the provider receives and interprets an image, not only its filename.
- Cover follow-ups and ordered mixed text/image content.
- Interrupt uploads, retry uncertain admission, and restart the runner.
- Reject foreign IDs, path traversal names, unsupported/spoofed types, oversized
  files, excessive decoded pixels and storage/concurrency quota exhaustion.
- Verify retention cannot remove attachments used by active or retained tasks.
- Verify target changes cannot reuse another runner's attachment references.
- Verify container replacement preserves content and provider-visible file access.
