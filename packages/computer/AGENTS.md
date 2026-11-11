# coforge-computer instructions

These rules extend the repository root `AGENTS.md` for this package component.

## Product boundary

`coforge-computer` is the sole installed native executable and user-facing CLI. It is not
a desktop UI, a cloud WebSocket client, or the owner of Daemon business logic.
The Computer starts or reuses the Daemon and talks to it through the local versioned RPC boundary. It may perform the one-time user-authorized setup registration, but the Daemon owns ongoing Workspace and Agent operation.
The executable dispatches `__daemon` to the Daemon runtime, `__agent-cli` to
the existing `@lrm/coforge/runner`, `__print-path` to the Daemon's login-shell PATH writer, `__lifecycle` to the installer's read-only
surface, and all normal invocations to the Computer management CLI. These internal modes do not make Daemon or Agent CLI public
management commands.
Normal lifecycle commands request startup through the platform user process
manager. `foreground` is the explicit public mode for containers and other
external supervisors; no command implicitly detaches an unmanaged fallback.
Upgrade runs the separately released `coforge-installer` (`release/upgrade-runner.ts`),
which owns the transaction, the service stop and start, and the receipt. Computer
launches it and reads the receipt; it does not roll back itself. `repair` runs the installer's
command of that name, and any installer operation settles an unfinished upgrade first. Only the installer registers the service; hosts run its `start`.

## Module map

`host/pi-chat-http.ts` and `host/pi-chat-workers.ts` retain the legacy adapter; `host/desktop-page.ts` adapts noVNC HTML.
`host/desktop-proxy.ts` owns desktop routes and forwarding. Current Pi Chat uses Workspace Daemon
WSS; `packages/daemon/src/pi-chat/` owns worker lifecycle. `__pi-chat` clears platform capabilities before using Pi.

Keep `src` organized by responsibility. New code belongs in the owning module;
do not grow `cli.ts` or `setup/` into an application god module. Paths are
relative to `src/`.

| Path                                                               | Boundary                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `main.ts`, `cli.ts`, `cli/`                                        | Binary entrypoint, the Commander command tree and its command wiring and output                     |
| `errors.ts`, `terminal-output.ts`, `logind-session-risk.ts`        | Stable CLI error stages, terminal-safe text, read-only Linux logind session-risk guidance           |
| `setup/`, `workspace/`, `registration/`, `cloud-rpc-transport.ts`  | Setup flow, direct Workspace lookup, registration idempotency, User-authenticated HTTPS RPC (`workspace:get`, `computer:register`) |
| `login.ts`, `oauth-device-client.ts`, `logout.ts`, `credential-store.ts` | Device-code authorization, local logout that keeps Workspace registrations, file-backed User credentials |
| `machine-id.ts`, `platform.ts`, `paths.ts`, `local-config.ts`      | Machine identity, platform metadata, platform-native paths, the validated persisted profile          |
| `release-channel.ts`, `release/channel-state.ts`, `cli/release-channel-command.ts`, `cli/update-command-registration.ts` | Compiled feed/server mapping, the durable fail-closed channel selector, and their CLI registration |
| `daemon-client/`, `daemon-service/`                                | Daemon lifecycle requests through the supervisor; the daemon host's inputs for this machine (shared with `__lifecycle service-definition`) |
| `host/`                                                            | Cluster runtime: register, heartbeat, claim Swarm service jobs, report them (files below)           |
| `status/`, `doctor/`, `runners/`, `logging/`                       | Read-only `status` report, diagnostics built from it, operator-only runner listing and stop, LogTape setup and `logs` |
| `detach/`, `network-error.ts`                                      | `detach` (server-confirmed, otherwise keeps the registration); transient network-error classification and the proxy hint |
| `updater.ts`, `version.ts`                                         | Reads the installed version; zod contract schemas and launcher text shared with the installer; build version |
| `release/upgrade-runner.ts`, `release/remote-upgrade.ts`, `release/detached-upgrade.ts`, `release/upgrade-operation.ts` | Run the installer for one upgrade or `repair`: from the CLI, server-triggered (redacted launch output, then the finished OS job removed), or as a detached job whose receipt is watched |
| `release/upgrade-receipt.ts`, `release/installer-contract.ts`, `release/supervisor-status.ts`, `release/lifecycle-command.ts` | Fallback failed receipt and `UpgradeFailedError`; shapes shared only with `coforge-installer`; what the supervisor runs; the hidden `__lifecycle` command |
| `release/coordinator-service-registrar.ts`, `release/installer-launch.ts`, `release/installation-source.ts` | `coforge-installer start`; fetching, verifying and caching the installer binary; the embedded release installer scripts |

`host/run-host.ts`, `host/host-cloud.ts`, `host/docker-containers.ts` and `host/container-binding*.ts` hold the host loop and its HTTPS client, Swarm service and volume naming, and the Daemon binding written on a container's volume.

`coforge-computer __lifecycle protocol|status|service-definition` is how the installer reads a
Computer (`service-definition`: the service file it registers, rendered by the daemon host). It prints exactly one JSON object on stdout (the `Lifecycle*` shapes), exits
with `LIFECYCLE_EXIT_CODE`, and writes nothing, since the installer also probes a candidate binary
that never ran. It has no pause, runner hold, or resume: an installer upgrade stops the service
outright and busy Agents are stopped with it. Do not add a control verb without a product decision. The
product's own upgrade and `__lifecycle status` share `release/supervisor-status.ts`.

`scripts/` holds build tooling that is never bundled; its rules are in
[scripts/AGENTS.md](scripts/AGENTS.md).
The install root (`<home>/.coforge/computer/install`) and the upgrade receipt reader are
owned by `@lrm/coforge-daemon` (`resolveComputerInstallDirectory`, `readUpgradeReceipt`);
the Computer imports them and does not rebuild either path.
Contract objects are `z.looseObject` (fields only get added). Resolve the home
directory with `os.homedir()` only, never `HOME`/`USERPROFILE` directly: the
installer follows the same rule (`crates/installer/contract/paths.json`).

The map describes ownership, not permission to create empty layers. Keep an
existing file in place when it still has one clear responsibility; move code
only when a real boundary is needed, and update this map in the same change.

Installing, verifying, and activating a version
belong to `coforge-installer` (`crates/installer/AGENTS.md`), which also fetches Pi's
`photon_rs_bg.wasm` (`docs/release/local-distribution.md`). The Computer never writes a version
directory.
`src/release/installation-source.ts` runs the embedded release installer scripts for version
resolution (`--resolve-only`) and the installer bootstrap. Nothing in the Computer downloads the product binary.
`src/release/installer-launch.ts` fetches `coforge-installer` through the same
scripts, pointed at `<feed>/installer` (pointer and manifest phases) plus their
`installer` phase, which downloads only that target's `coforge-installer(.exe).gz`;
it verifies size and checksum in TypeScript, keeps the binary in
`<install root>/installer/<sha256>/`, prunes to the current plus two more
recently used copies (ranked by use time, never hashed; a kept copy is verified before use),
and sweeps what a killed run left after an hour. With the feed unreachable it uses the newest
cached copy that hashes to its directory name (`installer-cache.ts`). It does not launch the
installer, read receipts, or touch the product's own upgrade transaction.
The install and upgrade transaction is serialized by the machine
mutation lock; do not narrow it to activation or reuse the Supervisor lifetime
mutex as the upgrade lock.

### Layer rules

- `main.ts`, `cli.ts`, and `cli/` know about process arguments and terminal
  concerns only.
- Command actions in `cli.ts` translate CLI input into application calls and
  translate results/errors into friendly output. They must not list
  Workspaces, scan runtimes, build registration payloads, read config files, or
  encode RPC.
- `setup/` owns the Computer setup business flow. It coordinates domain ports
  without knowing Commander or terminal output formatting.
- Read [the container host rules](../../docs/computer/container-host.md) when changing `host/`, `__attach-workspace`, the `foreground` container start, or the cloud Computer image.
- `workspace/` owns the direct Workspace lookup used by setup intent. Computer
  never lists or interactively selects Workspaces; do not add a picker or a
  list-selection flow.
- Authorization, machine identity, `registration/`, and `daemon-client/` each
  own the responsibility named in the module map. Their public methods should
  express that responsibility, while transport, filesystem, and subprocess
  details remain in lower adapters.
- Computer registration does not inventory Code Agent installations. Daemon
  discovers external providers from its effective PATH and reports a complete
  snapshot after startup and reconnect, so installing a provider never requires
  Computer re-registration.
- `status/` only reads through its injected ports; it never starts, stops, or
  configures anything. A running Workspace's `cloud=` comes from its own
  handshake, asked with a bounded wait; its error is remote text and is
  printed through `terminalText`.
- Do not add a catch-all `shared/` or utilities module. A value belongs to the
  module that owns its domain.

When a new command is added, first give its logic an owning directory (as
`status/` does) and identify the use case and reusable modules it calls. Do not add a second parser, command-specific
client, or command-specific copy of an existing domain operation.

- Treat the compiled CLI as the public seam. Cover command help, arguments,
  stdout/stderr, and exit codes with tests before changing behavior.
- Use Commander for the command tree. Do not add parallel handwritten argument
  parsing.
- `login` remains available for explicit re-authentication, but the normal
  user-facing flow is `setup`. When needed, setup performs OAuth login inside
  the same flow, uses a Workspace-page setup intent, registers the Computer,
  adds one Workspace binding, and starts (or reuses) its Daemon automatically. The
  user must never be asked to run `coforge-daemon` separately.
- `attach` is an additional public name for that same flow, declared through
  Commander's alias support in `src/cli.ts`. It accepts the same Workspace and
  JSON options and invokes the existing `setup/` use case. Do not create another
  registration, authentication, or startup implementation for this command.
- Setup takes the target Workspace from `--workspace <slug>`, which the Add
  Computer dialog renders with the current Workspace already filled in, so the
  user copies it rather than recalling it. `COFORGE_SETUP_INTENT` remains as the
  bypass for e2e and automation. A missing or malformed value fails stably.
- User authorization may authorize the one-time Computer registration. Long-lived
  User credentials and refresh tokens must not be persisted by Daemon or exposed
  to Agent runtimes. The approved GitHub integration may supply the Agent owner's
  current short-lived user access token on demand to a Git or `gh` child process;
  it must not persist that token or install it in the general Agent environment.
  Daemon otherwise uses its Computer/Workspace credential after setup.
- Never print access tokens, refresh tokens, device codes, or stored secrets.
- Resolve state through the platform-native path module; do not hand-build a
  hidden home-directory convention at call sites.
- Run `mise run test:computer`, `mise run check:computer`, and
  `mise run build:computer` before review. `test/installer-scripts.test.ts` runs
  `install.ps1` under PowerShell 7. `mise run test` and `mise run test:computer`
  install the version `mise.toml` pins (task tools, on first use); `mise run test:file` needs
  `pwsh` on PATH. Those tests fail without it and are never skipped.
