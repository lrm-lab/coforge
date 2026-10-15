# What the extracted tree contains

Module counts, package file counts, bundle size, and command lists are
version-specific. Record the values observed during each extraction in
the research note instead of carrying forward counts from an older release.

The first-party tree includes the human-facing Computer client, shared
contracts, sync and tracing code, and a pre-bundled daemon. The daemon bundle
does not expose one path comment per source file, so search it by command name
and preserved module labels.

## The agent-facing CLI

Find the daemon's `dist-*.js` and `chunk-*.js` files by role rather than by a
hard-coded filename. Search the CLI bundle for `program.name("raft")`, command
registration functions, and `src/commands/<group>/<name>.ts` labels. Registration
can be indirect, so validate the resulting command list against the bundle
instead of relying on one grep pattern.

When comparing a behavior, record the exact command name and extracted module
path. Do not infer that a command exists in the current release because it existed
in an older one.

## The human-facing commands

Start with `packages/computer/src/cli.ts` and `index.ts`. The current client
contains the setup, lifecycle, status, diagnosis, logs, runners, and upgrade
surfaces. Search the recovered `cli.ts` for the exact command registration
before comparing it with CoForge; in particular, verify whether a proposed
delete, remove, or detach operation is actually present.

## Where to start in `packages/computer/src`

- `cli.ts` registers commands; `index.ts` is the SEA entry.
- `service.ts`, `serviceControl.ts`, `serviceReconcileLoop.ts`, and
  `osSupervisor*.ts` implement the resident-service lifecycle under launchd and
  systemd.
- `externalInstaller.ts`, `lifecycleOperations.ts`,
  `residentLifecycleBridge.ts`, and release modules cover installation,
  upgrade, and lifecycle acknowledgements.
- `lib/runnerStateMachine.ts`, `runners.ts`, and `runnerLockConflict.ts`
  manage agent runner processes.
- `internal/ipc-server.ts`, `internal/ipc-codec.ts`, and `lib/ipc-client.ts`
  form the local IPC seam between CLI invocations and the resident process.
- `doctor.ts` and `health.ts` show recovery and health semantics, including how
  a server-side unlink or revoke is represented locally.

## Vendored dependencies

Record provider and protocol dependencies from the extracted tree when they
matter to the comparison. Treat dependency presence as evidence of bundled
code only; it does not prove that a CLI command or product capability is
enabled.
