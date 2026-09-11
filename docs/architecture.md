# Runner architecture and next slices

The desktop selects an execution target separately from a provider. A target owns
its project checkout, provider login, task processes and durable history.

This first slice implements only authenticated discovery and persistent identity.
It does not accept prompts or claim execution/replay support.

## Framework and execution boundaries

The service uses TypeScript on Node.js with NestJS and its Express HTTP adapter.
NestJS organizes composition, dependency injection and controllers; Express handles
the underlying HTTP transport. An injectable `RequestBoundary` middleware performs
authentication before routing, including requests for unknown routes. Framework
changes must preserve the versioned discovery contract and existing request restrictions.

The current authentication boundary verifies the editor's runner token. It is
separate from provider login: future Codex/Claude adapters will use credentials on
the execution host. NestJS does not supply those provider sessions or turn an HTTP
request into a durable agent task.

The intended application boundaries are:
- Domain: task states, commands, events and protocol validation.
- Application: task admission, scheduling, cancellation and recovery through ports.
- Infrastructure: durable task/event repository and Codex/Claude process adapters.
- Transport: versioned HTTP API and reconnectable event delivery.
- Composition: process configuration and lifecycle.

Future task, provider, attachment and project modules must depend on application
interfaces rather than Express request objects. Task admission will persist intent
before acknowledgment; a worker will own execution independently of client
connections. Disconnecting the editor must not cancel accepted work. Process or
server restart requires explicit recovery from persisted state; a framework or
container restart alone cannot resume an agent session.

Use the NestJS Express upload integration when implementing attachments, with
bounded streaming and runner-owned persistent storage. The framework upload
integration does not replace the ownership, durability, validation, retention and
provider-delivery requirements in the [attachment design](attachments.md).

## Dependency maintenance

`@nestjs/platform-express` 11.2.3 pins Multer 2.2.0, which has a known security
advisory. The package override to Multer 2.3.0 is intentional even though uploads
are not enabled in this foundation. Revisit the override when the upstream adapter
updates its dependency, and verify the resolved version before removing it.

## Next vertical slices

1. Durable attachment uploads and task admission with structured message parts,
   idempotency keys, bounded queues and event cursors. See [attachments](attachments.md).
2. One provider adapter, registered project roots, owned process groups, cancellation,
   bounded output and recovery that marks interrupted work truthfully.
3. Reconnect/replay and authenticated approval responses scoped to exact tasks.
4. Editor environment settings, project mapping, image paste/drop/file selection,
   persisted attachment previews, diff and verification results.
5. Second provider, toolchain images and per-task container execution.

Never accept arbitrary shell recipes from clients. Do not infer remote authority
from a Mac path. Keep authentication and sessions scoped to a runner. Provider
credentials stay on their execution host. Bind transport to loopback through SSH
until explicit TLS deployment is implemented. Docker packaging does not itself
isolate tasks from one another.

Each server needs a separate data volume and token. Never clone an initialized
identity volume onto a different logical server. A future protocol change must
negotiate compatibility; protocol version 1 currently covers discovery only.
