# daemon-host instructions

Rules for login-session startup in `src/daemon-host/`. They extend
`packages/daemon/AGENTS.md`.

- This directory owns startup through launchd, systemd user, and Windows task
  integration. It does not own Computer commands.
- Never fall back to a detached process when the platform manager is
  unavailable. Computer exposes foreground supervision as an explicit mode.
- Each host exposes `serviceDefinition()`, the text of its service file and, where the manager keeps
  one on disk, its `path`. The Computer's `__lifecycle service-definition` hands the text (not the
  path) to the installer, and `status` compares the file at `path` with it; do not render a second
  copy anywhere.
- A host never writes a service definition or registers a service. When the manager does not know
  the service (launchd: `print` fails; systemd: `LoadState=not-found`; Windows: `/Query` fails) it
  calls its injected `CoordinatorServiceRegistrar.registerAndStart()`, which the Computer
  implements by running `coforge-installer start`, and then waits for the local handshake. Do not
  add `bootstrap`, `enable`, `daemon-reload`, or `schtasks /Create` here.
- The service-control calls the hosts keep: `stop()`, systemd `start`/`restart`, Windows `/Run` and
  `/End` of a registered task, and launchd `restart()`'s `kickstart -k` of a loaded label, which
  restarts in place and registers nothing - the one such call the Computer still makes itself.
- Every host exposes `assertRestartable()`, which `coforge-computer restart --supervisor` calls
  before it restarts anything: it rejects when the manager does not know the service (launchd not
  loaded; systemd `LoadState=not-found`; Windows `schtasks /Query` fails), so a foreground,
  externally supervised Computer is refused instead of getting a second Coordinator registered.
