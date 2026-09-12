# Runner architecture

The desktop selects an execution target separately from a provider. Each runner
owns its registered project roots, provider login, task processes and durable history.
The default deployment stores drafts and PNG/JPEG attachments. Explicitly enabling
execution adds a persistent queue, one application worker, task-specific Git
worktrees, CLI processes, bounded output replay and diff retrieval.

## Local-first editor integration

New tasks default to the computer running the editor. Remote execution is an
explicit per-task choice in the context strip below the prompt, beside branch and
worktree controls, following T3 Code. Local and remote adapters implement a shared
application execution interface; local use does not require a remote runner.
See [execution target requirements](execution-targets.md) for defaults, placement,
settings and unavailable-target behavior. Remote editor integration remains pending.

## Framework and dependency boundaries

The service uses TypeScript on Node.js with NestJS and its Express HTTP adapter.
NestJS owns composition, dependency injection and routing. Pre-routing authentication
verifies the runner token before protected requests are handled.

Dependencies point inward:

- `src/domain/contracts.ts`: closed message, task, event and attachment types plus limits.
- `src/application/ports.ts`: asynchronous `TaskRepository`, `AttachmentRepository`
  and `AttachmentStore` interfaces; application workflows depend on these ports.
- `src/application/execution-ports.ts`: `ExecutionRepository`, `ProjectRegistry`,
  `ProjectWorkspace`, `ProviderExecutor` and attachment staging boundaries.
- `ExecutionService`: durable admission, sequential dispatch, cancellation and shutdown.
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
multiuser ownership isolation. Provider credentials belong to the execution host and remain separate from
editor-to-runner authentication. The bundled execution image stores provider home
in the persistent data volume. It is a single trusted Unix authority; project
worktrees do not prevent one agent from accessing other mounted runner data.

## Current transport scope

Authenticated HTTP supports draft creation, listing, retrieval and cancellation,
raw image uploads and retrieval, and cursor-based event polling. Event history
contains metadata and bounded CLI text output, not image blobs. Execution-enabled
instances expose project listing, explicit start and worktree diffs. There is no
SSE subscription, automatic editor reconnection, desktop image-paste UI or follow-up
submission.
See the [API contract](api.md) and [attachment scope](attachments.md).

The execution service persists queued intent before acknowledgment and owns its
worker independently of HTTP. A client disconnect does not cancel accepted work.
Only one task runs at a time. Startup marks previously running tasks interrupted
and drains pending queued work. Shutdown stops the active process; Docker's restart
policy does not resume provider sessions. Cancelled and terminal states win races
with late process results.

Projects are registered through an operator-owned JSON file. HTTP clients choose
an ID, never a source path or clone URL. A task starts in a detached worktree from
source `HEAD`; source dirty files are not copied. Worktrees, baseline revisions,
SQLite and attachment bytes persist under the data directory. Source Git roots
must also persist because worktrees refer back to their Git metadata. A task diff
compares against the recorded original baseline and separately lists untracked
filenames. No automatic local/remote checkout synchronization is implemented.

Provider adapters translate text and staged validated images into native CLI
inputs. Codex receives image paths; Claude receives image content blocks. The
execution Docker target bundles pinned Codex and Claude CLIs; provider
authentication is supplied by the operator. The container toolchain determines which
project commands can run. Application databases are separate project dependencies,
not the runner's SQLite store. No Docker socket or per-project container launcher
is included. The execution overlay selects `CODEVO_EXECUTION_ISOLATION=container`:
Codex runs with `--sandbox danger-full-access` and relies on the whole container
boundary. Native host execution keeps Codex in `workspace-write` isolation; Claude uses
`acceptEdits` with file tools and Bash allowed.
The container setting is not a per-task sandbox and gives the agent access to the
container user's mounted runner state, credentials and other projects.

## Dependency maintenance

The Multer 2.3.0 override is intentional while the NestJS Express adapter pins an
older version. This slice uses raw binary image uploads, not Multer multipart
handling. Revisit the override when the upstream dependency changes and verify the
resolved version before removing it.

## Next vertical slices

1. Editor environment connection, project mapping, image paste/drop/file selection,
   persisted attachment previews, remote diff and verification results.
2. Provider readiness/login UX, follow-up messages, approval responses and explicit
   interrupted-task continuation.
3. Explicit retention/deletion for tasks, worktrees and abandoned uploads.
4. Additional toolchain images and per-task container isolation.

Never accept arbitrary shell recipes from clients or infer remote authority from
a Mac path. Keep provider sessions scoped to their runner. Bind transport to
loopback through SSH until explicit TLS deployment is implemented. Docker packaging
does not itself isolate tasks from one another. Protocol changes must preserve or
explicitly negotiate compatibility rather than silently changing existing contracts.
