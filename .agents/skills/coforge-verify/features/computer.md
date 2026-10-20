# Computer

The installed `coforge-computer` executable, its setup/attach and lifecycle
commands, and the Web's Computers pages. Rules and the command contract are in
[`packages/computer/README.md`](../../../../packages/computer/README.md); the
native procedure is in
[Native Linux verification](../../../../docs/agents/e2e-testing/native-linux-setup.md).

## computer-setup

Attach this machine to a Workspace and start its Daemon.

- **Reach**: `coforge-computer setup --workspace <slug> [--json]`;
  `attach` is an alias (`packages/computer/src/cli.ts`). The Web's
  "Add computer" dialog gives the canonical command:
  `curl -fsSL <origin>/computer/install.sh | sh` (or `irm .../install.ps1 | iex`)
  with `--workspace <slug>` (`apps/web/src/features/install/install-commands.ts`).
- **Drive**: the first run with no saved login prints a device-code URL; open
  that exact URL in the browser and click Approve on `/oauth/verify`. Do not
  type the hyphenated code through an automation input setter: the field
  expects eight characters and normalizes real paste events
  ([Native setup investigation](../../../../docs/agents/e2e-testing/native-setup-investigation.md)).
- **Success**: `--json` stdout is one object with `ok: true`, `workspace`,
  `config_path`, `server_registration_created: true` and
  `daemon_started: true` (`daemon_still_starting: true` means follow it with
  `status`) (`packages/computer/src/cli/setup-output.ts`). The Workspace
  service is active and the Computers page shows the tile Online with its
  runtime inventory.
- **Failure codes** worth recognizing: `SETUP_WORKSPACE_NOT_FOUND`,
  `SETUP_WORKSPACE_LOOKUP_FAILED`, `SETUP_COMPUTER_REGISTER_FAILED`,
  `SETUP_DAEMON_START_FAILED`, `SETUP_BUILD_ENVIRONMENT_MISMATCH`
  (official builds are bound to production or staging and refuse a profile
  for the other environment).
- **Traps**:
  - Compiling a binary is not installing it; the service runs
    `~/.coforge/computer/install/active/coforge-computer`.
  - A fake `HOME` does not move the systemd user manager's search path; use a
    disposable OS user. `run-computer-setup.sh` refuses a `HOME` override.
  - Environment changes reach the Daemon only through the service manager
    (`systemctl --user import-environment`) followed by
    `coforge-computer restart`; a shell export does not.
  - `run-computer-setup.sh` also requires `COFORGE_E2E_HOME` (a disposable
    directory), which the example in the native setup doc omits.
  - Computer requires HTTPS locally: trust a local Caddy CA with
    `NODE_EXTRA_CA_CERTS`, never disable TLS checks.
- **Covered by**: `bun scripts/test/isolated-test-run.ts scripts/e2e/run-computer-setup.sh` (needs
  `COFORGE_E2E_WEB_URL`, `COFORGE_E2E_WORKSPACE_SLUG`, `COFORGE_E2E_HOME`,
  `OPENROUTER_API_KEY`, `COFORGE_E2E_ALLOW_INSTALL=1`; Linux/systemd only;
  writes `.amp/e2e/native-setup-result.json`, then runs
  `scripts/e2e/native-browser.e2e.ts`). `scripts/e2e/computer-environment.e2e.ts`
  drives the private fixture under `.amp/e2e/bin/` (needs
  `COFORGE_E2E_ALLOW_DEVICE_AUTH=1`). macOS and Windows setup have no harness:
  unverified by automation.

## computer-lifecycle

`start`, `stop`, `restart`, `status`, `logs`, `foreground`, and the upgrade
commands.

- **Reach**: `coforge-computer start|stop|restart [--workspace <slug-or-id>]`,
  `restart --supervisor`, `status [--json]`, `logs`,
  `install|upgrade [--version <v>] [--allow-downgrade]`, `upgrade --dry-run`,
  `recover` (`packages/computer/src/cli.ts`).
- **Drive**: scope to one binding with `--workspace`; without it the command
  targets every local binding, and a global restart keeps stopped bindings
  stopped. `--supervisor` and `--workspace` together fail with
  `RESTART_CONFLICTING_TARGET`. `upgrade` prompts `[y/N]` unless the target is
  already installed; `--dry-run` prints the plan and changes nothing.
- **Success**: `status` prints Install, Supervisor, Workspaces, Agents and locks;
  a Workspace needing attention shows a detail line with the retry command.
  It exits 0 even when unhealthy, except `STATUS_INSTALL_UNREADABLE` (exit 1).
  For `stop`/`start`, observe the process lifecycle through the command's own
  completion and `status`, then the product effect (for example, a Task created
  while stopped is handled after `start`).
- **Traps**:
  - Do not treat the Web Online dot as proof of shutdown: it follows a loader
    snapshot and a 90-second presence lease
    ([Native run guidance](../../../../docs/agents/e2e-testing/native-run-guidance.md)).
  - Do not restart a Workspace systemd unit directly; it left the Coordinator's
    recorded runtime identity stale and the installer refused upgrade with
    `Workspace runtime set is unhealthy`. Use `coforge-computer restart`.
  - Do not substitute an Agent Stop for a Daemon disconnection; Stop revokes
    capabilities and removes restart configuration.
  - `coforge-computer logs` follows the Computer log. Each Workspace Daemon logs
    to `logs/daemon/daemon.jsonl` in its own state directory; the per-category
    files in [`docs/local-logging.md`](../../../../docs/local-logging.md) are not
    implemented yet.
- **Covered by**: `scripts/e2e/installer-linux.sh` (fresh install, supervisor
  unit, upgrade with replay, rollback, SIGKILL recovery, `coforge-computer
  upgrade` through a loopback feed; runs only in the `coforge-linux` orb, deletes
  `~/.coforge` there; writes `.amp/e2e/installer-linux/<UTC>/summary.md`).
  The offline-recovery phase of `native-browser.e2e.ts` exercises `stop` and
  `start`. `packages/computer/test/machine-lifecycle.integration.ts` covers the
  lifecycle contract below the native install.

## workspace-crash-relaunch

A Workspace daemon that exits unexpectedly is started again within
`WORKSPACE_RELAUNCH_SECONDS` (`packages/daemon/src/supervisor/workspace-instance.ts`).

- **Reach**: SIGKILL a running Workspace daemon (its PID from `launchctl list`,
  `systemctl --user show -p MainPID`, or `coforge-computer status`); never one
  of a real Workspace you are not allowed to interrupt.
- **Drive**: wait on the observable relaunch (a new PID for the same launchd
  label or systemd unit), never a sleep. On macOS let the daemon run a moment
  first: launchd's throttle counts from the previous launch.
- **Success**: the macOS Workspace plist carries `ThrottleInterval` equal to the
  bound and a new PID appears within about that long; the systemd unit has the
  same `RestartSec`; on Windows the Coordinator's reconcile poll restarts it.
  Three unexpected exits within 60 s latch the Workspace degraded instead.
- **Traps**: official builds are bound to production or staging, so a local run
  without a real Workspace uses the macOS lifecycle fixture build
  (`packages/daemon/test/fixtures/build-macos-computer.ts`) in a throwaway state
  directory, started through `scripts/test/isolated-test-run.ts` so it cannot
  inherit a real Workspace's launchd prefix; boot out its jobs afterwards.
  An installed Computer picks up a changed plist only when the Workspace job is
  re-bootstrapped (an upgrade does this).
- **Covered by**: `packages/daemon/test/macos-supervisor.test.ts` (fixture
  build; kill-and-relaunch, degraded and parked paths). No Linux or Windows
  harness exercises a real relaunch.

## local-computer-reload

The edit-run loop for a Daemon or Computer source change on a machine that
already has a local binding.

- **Reach**: `mise run reload:computer` (`scripts/reload-local-computer.sh`):
  builds the fixture, installs it with a `coforge-installer` built from the
  checkout, and restarts `coforge-daemon.service`. `--setup <slug>` also runs
  setup; `--no-restart` installs only.
- **Success**: the service status it prints is active, and `coforge-computer
  status` reports the new version.
- **Traps**: Linux only (it exits 2 elsewhere). `COFORGE_E2E_WEB_URL` must match
  the running Daemon's server origin exactly; `localhost` and `127.0.0.1` differ.

## computers-page

- **Reach**: `/w/<slug>/computers` (desktop redirects to the first Computer's
  detail; mobile shows the list), detail at `/w/<slug>/computer/<id>`.
- **Drive**: list "Connected computers"; "Add computer" opens the install
  dialog ("Operating system", "Copy install command"). Detail has "Restart",
  a "Runtimes" section with "Rescan runtimes" (online only) and a per-runtime
  "Public" switch, and "Agents on this computer (N)" with Select → Start /
  Stop / Restart / Reset (`apps/web/src/features/computers/computer-detail.tsx`).
  Under the Version row of an outdated Computer the owner sees "Upgrade" and
  every member sees "What's new" when the release catalog has notes for that
  version; it opens a dialog titled "What's new in v<version>" ("更新内容" /
  "v<version> 更新内容" in zh-CN). A non-owner sees "v<version> available"
  instead of "Upgrade" (`computer-upgrade-slot.tsx`, `computer-release-notes.tsx`).
  Seed notes with `scripts/release/release-notes.ts --origin http://localhost:<port>`
  and a token whose SHA-256 is the server's `COFORGE_RELEASE_CATALOG_PUBLISH_TOKEN_SHA256`.
- **Success**: the tile's status dot is `role="img"` named "Online" or
  "Offline" (`computer-tile.tsx`, `status-dot.tsx`); there is no Online text
  badge. Restart toasts "Restart requested." then "Computer restarted." or
  "Restart did not complete before the deadline. Try again."
- **Traps**: Usage appears only for runtimes that support it; Pi, CoForge,
  Cursor and OpenCode show no health dot. A successful upgrade only changes the
  Version row and shows a toast. No upgrade offer shows when the Web's read of
  `<COFORGE_RELEASE_FEED_URL>/latest` fails: it has a 3 s timeout, and from a
  network outside mainland China the CDN often takes longer (observed
  2026-10-19), so reload until one read succeeds (it is cached 60 s). The HMR
  dev server stops on an avatar `?inline` import; serve the compiled build with
  `NODE_ENV=development ./scripts/start-web.sh` instead, which listens on
  `localhost` (IPv6 `[::1]`), not `127.0.0.1`.
- **Covered by**: no browser e2e found for this page.
