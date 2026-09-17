# Server execution lifetime

Once the runner accepts a task, closing the editor, losing the SSH connection or
turning off the client computer does not cancel it. The server and its runner
service must remain running. Reopening the editor reconnects to persisted task
state and retained output. Stopping a task explicitly cancels its process tree.

Each provider invocation has a finite wall-clock deadline. The default is **12
hours**, measured from provider launch. Waiting for an answer to an interactive
question uses this same budget; disconnecting does not pause or reset it. At the
deadline the process is stopped and its pending question expires. Queued time
before launch does not consume the budget. A continuation starts a new invocation
with its own budget.

Set `CODEVO_EXECUTION_TIMEOUT_MS` in the runner service's environment file to
change the deadline. Valid values are decimal integer milliseconds from **60000**
(one minute) through **604800000** (seven days). For example, `1800000` explicitly
retains a 30-minute deadline, `43200000` allows 12 hours, and `86400000` allows a
day. An omitted setting selects 12 hours; zero, empty, fractional, infinite and
out-of-range values fail startup rather than silently disabling the limit.

Apply environment changes only after active work completes: restarting the runner
interrupts running tasks. There is no automatic process recovery across a runner
or Linux restart. Saved history remains available, but the interrupted invocation
cannot continue waiting for input. The editor's server settings show the deadline
reported by the connected runner; older runners may not report it.

The deadline is an operator setting, not a prompt or project-controlled field.
It does not raise CPU/RAM limits, provider usage quotas, output retention budgets,
or process concurrency. Provider inference still runs at the provider. Local
builds and tests use the server's CPU, RAM and disk, subject to any limits imposed
by systemd, containers or the host administrator.

Claude print mode also has a separate background-agent wait ceiling. The runner
sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` for Claude launches so that the CLI's
default ten-minute background wait does not terminate unfinished agents. This does
not disable the runner's finite deadline or explicit Stop. An intermediate Claude
`result` closes this invocation's input but does not mark the task finished: the
runner continues recording background output and subsequent results until the CLI
exits. A later nonzero exit or runner cancellation cannot become a successful task
because an earlier result was successful.
