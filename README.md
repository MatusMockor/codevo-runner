# Codevo Runner

Standalone TypeScript execution-host service for Codevo, built with NestJS and its
Express adapter. **Durable draft storage, not yet an agent executor.** It provides
authenticated discovery, stable server identity, SQLite task drafts and events,
PNG/JPEG attachments and Docker deployment. Drafts survive restart but never enter
an execution queue. Provider login, agent execution, Git synchronization and editor
integration are not implemented yet.

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
Durable agent execution is a separate, planned application service, not a NestJS background
request or an automatic framework feature.

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
Each server gets its own data volume and token. This foundation image contains
Node, not provider CLIs or project build tools; those belong to the execution slice.

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

## API, protocol version 1

- `GET /healthz`: public liveness only; returns `{ "status": "ok" }`.
- `GET /v1/runner`: authenticated discovery with identity and capabilities.
- Draft tasks: create, list, retrieve, cancel and poll stored events.
- Attachments: authenticated raw PNG/JPEG upload, metadata and content retrieval.
- `taskDrafts`, `imageAttachments` and `eventReplay` are `true`;
  `taskExecution` remains `false`. Replay currently covers draft creation/cancellation.

Every `/v1` request requires `Authorization: Bearer <token>`. All token holders
share the runner's authority; there are no separate users or per-user permissions.
Browser Origin requests and unsupported routes/methods are rejected. JSON bodies
are accepted only for draft creation; uploads use raw binary bodies.

See [API details and limits](docs/api.md). The service stores up to 1,000 task drafts
and 256 attachments (256 MiB total attachment bytes). Retention/deletion is not
implemented; exhaustion is rejected rather than silently evicting history.

Updating the service can restart its process. Persisted drafts and attachments
remain, but future agent recovery must be explicit, not inferred from Docker's
restart policy.
