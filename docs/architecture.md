# Runner architecture and next slices

The desktop selects an execution target separately from a provider. A target owns
its project checkout, provider login, task processes and durable history.

This first slice implements only authenticated discovery and persistent identity.
It does not accept prompts or claim execution/replay support.

Planned boundaries:
- Domain: task states, commands, events and protocol validation.
- Application: task admission, scheduling, cancellation and recovery through ports.
- Infrastructure: durable task/event repository and Codex/Claude process adapters.
- Transport: versioned HTTP API and reconnectable event delivery.
- Composition: process configuration and lifecycle.

Next vertical slices:
1. Durable task admission with idempotency keys, bounded queues and event cursors.
2. One provider adapter, registered project roots, owned process groups, cancellation,
   bounded output and recovery that marks interrupted work truthfully.
3. Reconnect/replay and authenticated approval responses scoped to exact tasks.
4. Editor environment settings, project mapping, diff and verification results.
5. Second provider, toolchain images and per-task container execution.

Never accept arbitrary shell recipes from clients. Do not infer remote authority
from a Mac path. Keep authentication and sessions scoped to a runner. Provider
credentials stay on their execution host. Bind transport to loopback through SSH
until explicit TLS deployment is implemented. Docker packaging does not itself
isolate tasks from one another.

Each server needs a separate data volume and token. Never clone an initialized
identity volume onto a different logical server. A future protocol change must
negotiate compatibility; protocol version 1 currently covers discovery only.
