# platform instructions

Rules for OS primitives in `src/platform/`. They extend
`packages/daemon/AGENTS.md`.

- `operating-system.ts` is the single OS release observation, shared by
  Computer registration and Daemon ready reporting. On macOS, report the
  product version, not the kernel version.

## Logging

- `daemon-log-file.ts` prepares owner-only log paths and rejects symlinks. It
  must not wrap LogTape configuration or loggers.

## Processes

- `process-transport.ts` supplies pipe or opt-in terminal I/O to the shared process-tree owner and its launchd runner. Provider output is never parsed here.
- `posix-process-tree.ts` is the shared POSIX owner for direct launches and terminal children inside launchd. Terminal cleanup snapshots descendants before TERM and checks PID/start time before escalation, including children in another session. Whole-tree `terminate()` snapshots descendants before signaling too, so a member that escaped the child's process group (setsid/setpgid) is still signaled while its parent chain is intact. Keep turn-scoped pipe cleanup unchanged.
- `process-table.ts` owns host process observations and their clock, and the shared turn-scoped descendant kill both process owners run; process-table failure must not be treated as successful cleanup.
- Terminal descendants reparented before the first terminate/waitForExit observation cannot be identified by that snapshot, including a setsid child whose main process already exited. Pipe `terminate()` has the same limit: a descendant already adopted by init before its snapshot is unreachable.

- `launchd-agent-runner.ts` is the internal runner embedded inside each Agent
  job in Computer, never another installed product; it spawns the Agent child,
  relays its stdio and runs terminal cleanup on the owner's signals.
- An Agent relay lives in `/private/tmp/cf-agent-<identity>-XXXXXX/stdio.sock` (the
  Workspace's launchd identity). `stopLaunchdAgents` sweeps it with the prefix's Agent jobs;
  it never touches legacy random names, and keeps directories younger than the startup timeout.
  The real-launchd cases live in `test/launchd-process.integration.ts`: `bun test` does not pick
  it up, and the macOS lifecycle CI job runs it.
- An executable the Agent's PATH cannot resolve fails the spawn with
  `RuntimeExecutableNotFoundError` (`code: "runtime_not_found"`), whether it
  is spawned directly, through launchd, or into a Job Object. Any other
  `ENOENT` while spawning (a missing working directory) stays the plain
  spawn error.
- `windows-job-object.ts` owns Win32 Job Object create/assign/terminate and
  ActiveProcesses queries. On Windows, `process-tree.ts` places external Agent
  children in a Job Object and waits for an empty job before allowing a
  replacement launch. When the Job Object APIs cannot be loaded, it fails
  closed.
- `agent-launch-tag.ts` owns the `COFORGE_AGENT_LAUNCH_TAG` name and its
  `<agentId>:<launchToken>` value; `agent-launch-tag-sweep.ts` collects the
  processes carrying it — including descendants that setsid, double-forked or
  reparented to launchd before the process-tree snapshot. It runs only where
  the Daemon decided the Agent really stopped: an explicit Stop, a crash exit
  no relaunch will replace, or the Agent's first launch since this Daemon
  process started (which clears what a previous Daemon's crash left). A wake,
  cold-idle recycle, stalled recovery or turn boundary never sweeps, so
  background processes the Agent still uses survive them. The sweep extracts
  the tag while parsing and never retains raw environment text, verifies pid
  plus start time before every signal, and a scan failure degrades to the
  previous cleanup behavior. Documented boundaries it cannot reach: a
  descendant that scrubs its environment (`env -i`), a process launchd or
  `open` starts outside the Agent's own chain, a provider tool that spawns
  outside the session environment (a Pi extension that defines its own bash
  tool), and — on macOS only — a process whose executable is an Apple
  platform binary (`sh`, `sleep`, `tail`): the kernel does not expose their
  environment to `ps eww`, so they are invisible to the scan. Linux `/proc`
  has no such restriction. On macOS `ps eww` also mixes command arguments
  into the same tail as the environment, so a command argument containing a
  complete tag-shaped value can match; the value's rigid UUID:UUID shape
  makes accidental matches vanishingly unlikely.

## Login-shell PATH and environment

- `login-shell-path.ts` reads PATH and the allowlisted environment from the user's login shell
  (zsh, bash, sh, dash, ksh, fish) by running the Computer executable's hidden
  `__print-path <file> <nonce>` in it; the result file's nonce is the only thing
  trusted, never the shell's output. `COFORGE_LOGIN_SHELL_PATH=0` turns it off.
  `login-shell-env.ts` decides which variables may cross: proxy and locale names plus
  credential-shaped suffixes (`*_API_KEY`, `*_TOKEN`, …); `COFORGE_*` is always denied.
  Never widen that allowlist without a security review.
- The captured env lives only in the probing process's memory — each Workspace Daemon
  re-runs the probe for itself (`daemon-runtime/login-shell-env.ts`) and fills only
  variables its spawn environment lacks. It must never be written to
  `login-shell-path.json` or any other state file; `writeLoginShellPath` strips it.
- `login-shell-path-state.ts` stores the result in the Coordinator's state directory.
  A failed probe overwrites an earlier success; each retry of a transient failure
  (see `supervisor/login-shell-path-import.ts`) records its own result.
  `code-agent-path.ts` searches the current PATH, then these directories, then its defaults; candidates still pass
  the usual executable validation. The login-shell directories come before the built-in
  defaults on purpose: the user's terminal PATH wins over our guesses. Only a timeout or
  abort kills the probe's process group; processes the rc files leave running after a normal
  exit are not killed.

## Locks

- `process-lock.ts` is the reusable SQLite-backed process lock primitive. The
  Supervisor lifetime lock uses it only for foreground exclusion and safe
  recovery of owned children; Computer uses it separately for its
  full-operation machine mutation lock. Do not reuse one lock for the other.
- Lock files are permanent local-filesystem inodes with no tables or business
  data. Never replace or unlink them.
