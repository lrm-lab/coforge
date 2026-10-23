# platform instructions

Rules for OS primitives in `src/platform/`. They extend
`packages/daemon/AGENTS.md`.

- This directory holds OS-specific details only. Expose them through
  interfaces such as the process-tree seam; do not leak platform APIs upward.
- `operating-system.ts` is the single OS release observation, shared by
  Computer registration and Daemon ready reporting. On macOS, report the
  product version, not the kernel version.

## Logging

- `daemon-log-file.ts` prepares owner-only log paths and rejects symlinks. It
  must not wrap LogTape configuration or loggers.

## Processes

- `launchd-job.ts` owns launchd user-job registration and native observations.
- `launchd-process.ts` runs external Agent stdio and cleanup in a separate
  launchd job behind the process-tree interface. Its internal runner is
  embedded in Computer, never another installed product.
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

## Login-shell PATH

- `login-shell-path.ts` reads PATH, and only PATH, from the user's login shell
  (zsh, bash, sh, dash, ksh, fish) by running the Computer executable's hidden
  `__print-path <file> <nonce>` in it; the result file's nonce is the only thing
  trusted, never the shell's output. `COFORGE_LOGIN_SHELL_PATH=0` turns it off.
  Do not import any other variable from the shell.
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
