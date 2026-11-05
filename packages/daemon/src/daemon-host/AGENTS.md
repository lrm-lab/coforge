# daemon-host instructions

Rules for login-session startup in `src/daemon-host/`. They extend
`packages/daemon/AGENTS.md`.

- This directory owns startup through launchd, systemd user, and Windows task
  integration. It does not own Computer commands.
- Three ways the Coordinator runs, and who starts it in each: (1) a platform manager (launchd,
  systemd user, Windows task) starts it; (2) a Linux machine without systemd (`/run/systemd/system`
  missing or no `systemctl` on `PATH`, `systemdPresent`) runs the Computer's own detached process,
  started by the installer's `Detached` backend (`DetachedDaemonHost`), with no start at boot and no
  restart after a crash, which `status` says; (3) a Computer declared externally supervised
  (`COFORGE_COMPUTER_EXTERNAL_SUPERVISOR`, verified by `external-supervisor.ts`) is started and
  restarted only through its recorded unit and never gets a second service beside it. A machine with
  systemd but no user session bus is none of these: it is an error that says what to do, never a
  quiet detached process. Foreground supervision stays an explicit mode.
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
