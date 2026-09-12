# Codevo Runner

Standalone TypeScript execution-host service for Codevo, built with NestJS and its
Express adapter. It provides authenticated discovery, stable server identity,
SQLite task/event storage and PNG/JPEG attachments. Execution is **explicitly opt-in**:
the execution deployment runs CLI agents in task-specific Git worktrees and persists
a queue and output independently of the client connection. The default deployment
remains a draft/attachment service. Remote editor integration, automatic project
synchronization and a provider-login UI are not implemented.

See the [API with examples](docs/api.md), [architecture](docs/architecture.md) and
[implemented attachment scope and future requirements](docs/attachments.md).

## Local development

Requires Node 24.13+ (24.x).

```sh
npm ci
npm run check
npm run build
npm test
mkdir -p secrets
node -e "require('fs').writeFileSync('secrets/runner-token', require('crypto').randomBytes(32).toString('base64url') + '\n', {mode: 0o600, flag: 'wx'})"
CODEVO_TOKEN_FILE=secrets/runner-token npm start
```

`npm run build` compiles TypeScript; `npm start` runs `dist/src/main.js`.
Rebuild after source changes before starting the service. NestJS supplies HTTP
routing and dependency injection; authentication runs in pre-routing middleware.
Durable agent execution is an application service with a persisted queue and an
owned worker; it is not tied to the lifetime of an HTTP request.

Default listener: `127.0.0.1:4318`. `CODEVO_DATA_DIR` defaults to `.codevo`.
Set `CODEVO_NAME`, `CODEVO_HOST`, and `CODEVO_PORT` to override defaults. The token
is loaded at startup; restart after rotation. Never commit or log token contents.

## Docker on a Linux server

Create a unique token as above. The image runs as UID 1000; ensure that user can
read the host token file mounted by Compose (file secrets preserve host ownership).
Then run:

```sh
docker compose up -d --build
docker compose ps
```

Optional: after building the image, run `python3 scripts/docker-smoke.py` to verify
authenticated discovery, nonroot execution, clean shutdown and identity persistence
across container replacement. It creates and removes its own temporary containers
and data volume. Pass an image tag as the first argument to check a different image;
the default is `codevo-runner:0.1.0`.

Docker Engine and Compose must be installed and Docker must start on boot.
The Compose project defaults to `codevo-runner`. Its project-scoped volume
`codevo-runner_runner-data` retains identity, SQLite data and attachment files
when the container is recreated. Use local server storage for this volume, not a
shared network filesystem; run one runner instance per data directory.
Do not use `docker compose down -v` unless intentionally deleting runner state.
Each server gets its own data volume and token. The default image contains Node
and keeps execution disabled. Use the explicit execution overlay below to install
the provider CLI and development tools.

### Multiple runners on one server

Use a separate checkout and token for each instance, a unique Compose project name,
and a different host port:

```sh
# Run from the personal instance checkout.
CODEVO_PORT=4318 docker compose -p codevo-personal up -d --build
# Run from the work instance checkout, with its own secrets/runner-token.
CODEVO_PORT=4319 docker compose -p codevo-work up -d --build
```

These instances use `codevo-personal_runner-data` and `codevo-work_runner-data`.
Compose also scopes their container and network names. Keep volumes project-scoped;
do not add a global volume `name`, an external shared volume, or a fixed
`container_name`. Use the same `-p` value for subsequent management commands, such
as `docker compose -p codevo-work ps`.

If an existing deployment used a different project name, keep that name with `-p`
(or `COMPOSE_PROJECT_NAME`) when updating. Changing the project name selects a new
volume; it does not migrate or delete the old data.

Compose publishes only on server loopback. From a client machine, forward it:

```sh
ssh -N -L 4318:127.0.0.1:4318 codex@192.168.1.110
```

SSH is the transport protection; token authentication remains required. The HTTP
service has no TLS and should not be published directly to the public internet.
No Docker socket or host home directory is mounted.

## Enable agent execution

Run these steps on the Linux server, from this repository checkout. Create the
runner token first as described above. The execution image includes pinned Codex
0.154.0 and Claude Code 2.1.270 CLIs, Git, Node/npm, Python 3, make and a C++ compiler.
CLI versions can be overridden with `CODEX_CLI_VERSION` and `CLAUDE_CLI_VERSION`
build settings. Other language runtimes and project services must be supplied
explicitly. No Docker socket is mounted.

1. Create `config/projects.json` with the **container-visible** Git root:

   ```json
   [{ "id": "my-app", "name": "My app", "path": "/data/projects/my-app" }]
   ```

   The `config` directory and file must exist before Compose starts. Registration
   accepts 1–32 projects and is read at startup; restart after changing it.

2. Build the execution image and prepare your repository in persistent storage:

   ```sh
   docker compose -f compose.yaml -f compose.execution.yaml build
   docker compose -f compose.yaml -f compose.execution.yaml run --rm runner \
     git clone https://github.com/YOUR-ORG/YOUR-REPO.git /data/projects/my-app
   ```

   Replace the example URL with your repository and configure Git authentication
   on the server for private repositories. This is an operator setup command;
   the HTTP API does not accept clone URLs or arbitrary filesystem paths.
   Alternatively bind-mount an existing server checkout at a stable container path
   in your own Compose override. It must be writable by UID 1000 because Git
   worktree creation writes metadata in the source repository.

3. Authenticate the provider you want to use inside the execution image, then start
   the service. For Codex:

   ```sh
   docker compose -f compose.yaml -f compose.execution.yaml run --rm runner \
     codex login --device-auth
   docker compose -f compose.yaml -f compose.execution.yaml up -d
   docker compose -f compose.yaml -f compose.execution.yaml ps
   ```

   For Claude, run the same `compose ... run --rm runner` command with `claude`
   and complete its interactive login before submitting Claude tasks.
   Credentials persist under `/data/provider-home` in this runner's volume. This
   provider login is separate from the runner's bearer token. A registered project
   or an enabled execution capability is not proof that provider login is valid.

4. Open the SSH tunnel and use the [API walkthrough](docs/api.md#start-and-observe-a-task)
   to list projects, create a draft, start it and retrieve events and the diff.
   Keep both `-f` arguments (and your `-p` name, if used) for all management commands.

Code and dependencies live in persistent storage, not in the image. Each task
starts from the registered repository's current committed `HEAD` in a detached
worktree under `/data/workspaces`; uncommitted source edits are not copied. Fetch or
update the source explicitly before starting tasks when you want a newer baseline.
The source repository must remain available at the same path for its worktrees.
There is no automatic synchronization with the Mac's checkout, push, merge or
application of remote changes. Review the returned diff before transferring work.

One task runs at a time. An SSH/client disconnect does not stop it. On runner
restart, queued work remains eligible to run and work that was running becomes
`interrupted`; it is not automatically resumed. Start a new draft for a new attempt.
Cancellation stops the active process group. This is one trusted execution host:
worktrees separate normal edits but are not per-task security sandboxes, and agent
processes share the container user and mounted data, including runner state,
provider credentials and other projects. Only run trusted projects.

The overlay explicitly sets `CODEVO_EXECUTION_ISOLATION=container`. In this mode,
Codex uses `--sandbox danger-full-access`: the complete hardened Docker container
is the isolation boundary, since nested provider sandbox namespaces are not
available in this deployment. This does not isolate individual tasks. Direct host
execution keeps Codex in `workspace-write` isolation; do not select container
mode on a host expecting the CLI sandbox to protect it. Claude uses `acceptEdits`
with the configured file tools and Bash allowed. Provider processes run
noninteractively; an approval-response UI is not included.

Docker smoke checks cover installed tools, real project commands and persistence.
They do not authenticate providers or run a paid model request; perform a small
end-to-end task with your own provider account before relying on the deployment.

## API, protocol version 1

- `GET /healthz`: public liveness only; returns `{ "status": "ok" }`.
- `GET /v1/runner`: authenticated discovery with identity and capabilities.
- Tasks: create drafts, list, retrieve, cancel and poll stored events.
- Opt-in execution: list registered projects, start tasks and retrieve worktree diffs.
- Attachments: authenticated raw PNG/JPEG upload, metadata and content retrieval.
- `taskDrafts`, `imageAttachments` and `eventReplay` are `true`;
  `taskExecution` reflects whether execution was enabled for this process.

Every `/v1` request requires `Authorization: Bearer <token>`. All token holders
share the runner's authority; there are no separate users or per-user permissions.
Browser Origin requests and unsupported routes/methods are rejected. JSON bodies
are accepted for draft creation and task start; uploads use raw binary bodies.

See [API details and limits](docs/api.md). The service stores up to 1,000 tasks
and 256 attachments (256 MiB total attachment bytes). Retention/deletion is not
implemented; exhaustion is rejected rather than silently evicting history.

Updating the service can interrupt active work. Back up the complete data volume
while the runner is stopped; include external registered repositories if using
bind mounts. Provider credentials in that volume are sensitive. Workspaces and
project dependencies currently have no automatic cleanup or disk quota.
