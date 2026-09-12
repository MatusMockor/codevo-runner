# Execution targets in the editor

Status: accepted product requirements; editor integration is not implemented yet.

## Default and selection

New tasks default to the computer running the desktop editor. Local execution must
remain available without configuring or contacting a remote runner. Adding a server
or using a remote target for one task must not change the default for later tasks.
There is no automatic load balancing or implicit switch to remote execution in
this phase. Existing tasks reopen on the exact target where they were created.

Execution target is separate from provider/model and separate from checkout versus
worktree isolation. Select the target before creating the task; capture its identity
and project mapping for every asynchronous operation. Do not move an existing task
by changing a dropdown. An explicit future transfer workflow is separate work.

## Placement, following T3 Code

Use a compact execution-context strip immediately below the prompt composer,
alongside the existing branch/worktree controls. The target selector is visible
there as a computer/server icon and readable machine name, such as `This computer`
or `Home server`. Do not bury per-task selection in global settings. Keep the local
indicator visible even before a server is configured so the execution location is
clear. On narrow layouts use a compact context menu, preserving the target label
and accessible `Run on` name.

The T3 Code reference inspected is its `BranchToolbar` context strip, which embeds
`BranchToolbarEnvironmentSelector` alongside execution/worktree controls:
- https://github.com/pingdotgg/t3code/blob/211618fd9fe39d3dde01171a6856ce9f633571c9/apps/web/src/components/BranchToolbar.tsx
- https://github.com/pingdotgg/t3code/blob/211618fd9fe39d3dde01171a6856ce9f633571c9/apps/web/src/components/BranchToolbarEnvironmentSelector.tsx

Settings contain a separate `Environments` section to add/edit/remove SSH servers,
check reachability, and show runner/provider readiness. These settings manage
connections; the composer chooses where a particular new task runs.

## Routing and unavailable environments

Use one application execution gateway with local and remote adapters. The local
adapter uses the editor's existing native process capability; it must not require
Docker or an HTTP runner installation on the user's computer. The remote adapter
uses the selected server's authenticated runner and capabilities.

A saved remote connection is not proof that execution is available. The current
runner only advertises draft storage and images, with `taskExecution: false`.
Never offer it as a runnable target until the required execution/provider/project
capabilities are implemented and verified. It may be shown as configured but not
ready, with a clear reason.

If a selected server is unavailable, retain the selection and explain why sending
is blocked. Never silently execute on a different machine. A disconnected existing
remote task remains associated with that server while the client reconnects.

Selecting a new target invalidates destination-specific provider status, project
paths and attachment references. Upload images to the chosen remote runner before
accepting execution; local tasks use locally owned inputs. Do not lose the typed
prompt or local attachment sources when switching a draft's target.

## Acceptance checks for the editor slice

- Fresh installation and every new task default to the editor's own computer.
- Adding or selecting a server does not silently change that default.
- The composer shows the target next to branch/worktree controls.
- Provider and isolation selectors do not substitute for target selection.
- Local tasks work without a remote connection or local Docker service.
- An offline or discovery-only server cannot receive an execution request.
- Reopening a remote task retains its server and restores its stored history.
- Switching a draft target preserves text while replacing target-scoped references.
