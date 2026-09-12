# Runner architecture and next slices

The desktop selects an execution target separately from a provider. Each runner
will own its project checkout, provider login, task processes and durable history.
The current slice stores task **drafts**, PNG/JPEG attachments and creation/cancellation
events. It does not queue or execute an agent and has no project checkout integration.

## Local-first editor integration

New tasks default to the computer running the editor. Remote execution is an
explicit per-task choice in the context strip below the prompt, beside branch and
worktree controls, following T3 Code. Local and remote adapters implement a shared
application execution interface; local use does not require a remote runner.
See [execution target requirements](execution-targets.md) for defaults, placement,
settings and unavailable-target behavior. These editor changes are planned.

## Framework and dependency boundaries

The service uses TypeScript on Node.js with NestJS and its Express HTTP adapter.
NestJS owns composition, dependency injection and routing. Pre-routing authentication
verifies the runner token before protected requests are handled.

Dependencies point inward:

- `src/domain/contracts.ts`: closed message, task, event and attachment types plus limits.
- `src/application/ports.ts`: asynchronous `TaskRepository`, `AttachmentRepository`
  and `AttachmentStore` interfaces; application workflows depend on these ports.
- Infrastructure: SQLite repository and runner-owned attachment files implement the ports.
- Transport/composition: HTTP validation, response mapping, wiring and lifecycle.

SQL and filesystem details stay out of controllers and domain contracts. SQLite
operations run in a dedicated worker thread so synchronous database calls do not
block the HTTP event loop. This database worker is **not** an agent execution worker.
The adapter uses Node 24's experimental `node:sqlite` driver; the runtime is pinned
to Node 24 and the repository boundary isolates that driver from application code.

## Persistence and authority

Each runner uses its own `runner.sqlite` under `CODEVO_DATA_DIR`, with WAL journaling,
FULL synchronous durability and foreign keys. Task creation, attachment references,
idempotency and the creation event are committed transactionally. Cancellation and
its event are also transactional. Repeated identical task admission returns the
existing task; reusing its idempotency key with different content is a conflict.

Attachment bytes live beside the database in runner-owned storage. The database,
attachment files and runner identity belong in the same persistent Docker volume.
Use local disk on the execution host, not a shared network filesystem for SQLite.
A separate `runner-lease.sqlite` connection holds an exclusive transaction for the
runner lifetime. A second live runner using that directory fails before attachment
reconciliation; closing the connection or process exit releases the OS-backed lock.
Do not remove or replace this lease file while the runner is active. The lease does
not hold a long-running transaction on the task database.

Do not share a data directory between runner instances or copy an initialized
identity to a different logical server. Independent servers have independent data
and tokens; they do not share a scheduling database.

For consistent backups, stop the runner and back up the entire data directory.
Copying only `runner.sqlite` while the service is active can miss WAL transactions
and does not preserve attachment content. Container replacement preserves stored
data only while its volume is retained; a restart policy is not task recovery.

All clients holding the runner token share one authority in this MVP. This is not
multiuser ownership isolation. Provider credentials, once implemented, will belong
to the execution host and remain separate from editor-to-runner authentication.

## Current transport scope

Authenticated HTTP supports draft creation, listing, retrieval and cancellation,
raw image uploads and retrieval, and cursor-based event polling. Event history
contains metadata, not binary blobs. There is no SSE subscription, automatic live
reconnection, desktop image-paste UI, follow-up submission or provider execution.
See the [API contract](api.md) and [attachment scope](attachments.md).

The next execution slice must persist intent before acknowledging queued work and
own agent processes independently of HTTP connections. Disconnecting the editor
must not cancel accepted execution. Recovery after a process or server restart
must mark interrupted work truthfully; NestJS and Docker do not resume agent sessions.

## Dependency maintenance

The Multer 2.3.0 override is intentional while the NestJS Express adapter pins an
older version. This slice uses raw binary image uploads, not Multer multipart
handling. Revisit the override when the upstream dependency changes and verify the
resolved version before removing it.

## Next vertical slices

1. One provider adapter, registered project roots, owned process groups, scheduling,
   bounded output, cancellation and truthful interrupted-task recovery.
2. Follow-up messages, provider image delivery, approval responses and reconnectable
   execution event delivery scoped to exact tasks.
3. Editor environment settings, project mapping, image paste/drop/file selection,
   persisted attachment previews, diff and verification results.
4. Explicit retention/deletion for tasks and abandoned uploads, with safe reference checks.
5. Second provider, toolchain images and per-task container execution.

Never accept arbitrary shell recipes from clients or infer remote authority from
a Mac path. Keep provider sessions scoped to their runner. Bind transport to
loopback through SSH until explicit TLS deployment is implemented. Docker packaging
does not itself isolate tasks from one another. Protocol changes must preserve or
explicitly negotiate compatibility rather than silently changing existing contracts.
