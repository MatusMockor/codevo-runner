# Codevo Runner

Standalone execution-host service for Codevo. **Early foundation, not yet an agent
executor.** It currently provides authenticated discovery, stable server identity,
Docker deployment and integration tests. No prompts, provider logins, task history,
Git synchronization or editor integration are implemented yet.

## Local development

Requires Node 24.13+ (24.x).

```sh
npm ci
npm run check
npm test
mkdir -p secrets
node -e "require('fs').writeFileSync('secrets/runner-token', require('crypto').randomBytes(32).toString('base64url') + '\n', {mode: 0o600, flag: 'wx'})"
CODEVO_TOKEN_FILE=secrets/runner-token npm start
```

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

Docker Engine and Compose must be installed and Docker must start on boot.
The named `runner-data` volume retains identity when the container is recreated.
Do not use `docker compose down -v` unless intentionally deleting runner state.
Each server gets its own data volume and token. This foundation image contains
Node, not provider CLIs or project build tools; those belong to the execution slice.

Compose publishes only on server loopback. From a client machine, forward it:

```sh
ssh -N -L 4318:127.0.0.1:4318 codex@192.168.1.110
```

SSH is the transport protection; token authentication remains required. The HTTP
service has no TLS and should not be published directly to the public internet.
No Docker socket or host home directory is mounted.

## API, protocol version 1

- `GET /healthz`: public liveness only; returns `{ "status": "ok" }`.
- `GET /v1/runner`: requires `Authorization: Bearer <token>` and returns
  `protocolVersion`, `runnerId`, `name` and `capabilities`.
- `taskExecution` and `eventReplay` are explicitly `false`.
- Browser Origin requests, request bodies and non-GET methods are rejected.

See [architecture and next slices](docs/architecture.md). Updating the service can
restart its process; future task recovery must be explicit, not inferred from a
Docker restart policy.
