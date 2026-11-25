# Agent background jobs (`coforge proc`)

`coforge proc` manages detached, per-Agent background jobs through the local
Daemon proxy so long-running dev servers, builds, and watchers survive Agent
turns, provider session replacement, and Daemon restarts.

## Commands

```sh
coforge proc start [--name <name>] [--cwd <dir>] [--env KEY=VALUE]... [--json] [--] <command> [args...]
coforge proc list [--json]
coforge proc logs <name> [--tail <lines>] [--follow] [--json]
coforge proc stop (<name> | --all) [--force] [--json]
```

- **Auto-naming**: omitting `--name` derives a name from the executable
  (`1-40` characters matching `[A-Za-z0-9_-]`) and appends `-2`, `-3`, ... on
  collision with a running job. Reusing the name of an exited job replaces that
  exited record and resets its log file.
- **Working directory**: `--cwd` resolves relative to the Agent workspace
  directory and must exist as a directory.
- **Environment**: jobs inherit the Workspace environment plus `--env KEY=VALUE`
  overrides, with transient CoForge Daemon launch variables (`DAEMON_LAUNCH_ENV_KEYS`)
  stripped so background processes do not carry Agent tokens or sockets.
- **Follow streaming**: `proc logs <name> --follow` polls for up to `30s`
  (`--tail` defaults to `50`, max `2000`; each poll slice is bounded to `256 KiB`).

## Limits, logs, and storage

- Each Agent may run at most **8** concurrent jobs (`proc_limit`).
- Up to **8** exited job records are retained per Agent (oldest pruned first).
- Combined `stdout` and `stderr` are written to
  `<agentWorkspace>/proc-logs/<name>.log` (`0o700` dir, `0o600` file, symlinks
  rejected) and rotated to `.log.1` when a running job exceeds **20 MiB**.
- Per-Workspace state is stored in `<workspaceState>/proc-jobs.json`.

## Memory limits

New jobs have a **4096 MiB** memory limit. Set `memoryMaxMb` in the Computer configuration
file `computer/proc.json` under the CoForge user directory (normally
`~/.coforge/computer/proc.json`). For example, `{"memoryMaxMb": 8192}` sets 8 GiB.
The value must be a nonnegative integer. Use `0` to disable the limit.
Changes apply to new jobs. An invalid value rejects new starts.

- **Linux systemd cgroup hard limit** applies when user systemd 253 or later and the cgroup v2
  memory controller are available. The kernel enforces the cap with swap disabled. Usage
  reflects memory charged to the cgroup. A kernel stop whose cause cannot be verified is
  recorded as an exit with no confirmed memory-limit reason.
- **Process-group RSS sampling** applies on macOS and on Linux when the hard limit is unavailable.
  The daemon stops the job after two consecutive samples above the limit, taken 15 seconds apart.
  Shared pages can count more than once, so prefork and copy-on-write workloads can reach the
  limit earlier. Processes that leave the original group escape this sampling and its automatic
  stop. If ownership is lost, automatic stops are suspended until ownership can be verified.

`coforge proc list` shows each capped job's mode, limit and last available usage. The JSON from
`proc list` and `proc logs` includes these fields when known. Computer status shows the mode,
limit and ownership of running jobs, with usage unknown when it has no cached reading.
A confirmed memory-limit stop appears as “stopped at its memory cap” and adds one item to the
owner's App Inbox without starting the Agent. The job stays stopped.

Before downgrading to a version without memory-limit support, stop or finish capped jobs so
the older daemon does not lose their management records.

## Lifecycle and operator control

- Running jobs stay alive across Agent turns, session replacement, and normal
  Daemon stops. On startup, the Daemon recovers each job using its recorded
  process, process-group anchor or cgroup identity.
- All running jobs for an Agent stop automatically (SIGTERM with SIGKILL
  escalation) when the Agent is stopped, deleted/reset, or migrated, or when
  a Workspace is deleted.
- On Linux without user `systemd-run`, jobs fall back to a detached process
  group (`stopsWithService: true`).
- `coforge-computer status` surfaces running Agent background jobs across
  Workspaces; `coforge-computer stop --jobs` stops all running background jobs.

## Availability

- Supported on macOS and Linux Daemons when the Agent runtime is active; Windows
  Daemon hosts return `proc_unsupported`.
- External Agents connecting via `agent login` or `agent bridge` receive an
  unsupported-for-external-Agents refusal (`UNSUPPORTED_FOR_EXTERNAL_AGENTS`).
