# coforge-installer module map

These rules extend `crates/installer/AGENTS.md` for `crates/installer/src/`. The modules list has
one line per module: its file and single responsibility. Update it before adding or reorganizing
a module.

## Install layout (POSIX)

How it works is in `src/current.rs` and `src/active.rs`; these are the rules.

- Nothing runs from `versions/<v>/`, the verified store and rollback source: the product runs from
  `current/`, which `active` links to for good.
- Activation runs only after the product's processes are stopped, and `VersionStore::
  executables_to_stop` names the executables to stop: `current/`'s, and the version executables a
  process started before `current/` existed still runs.
- Repair does not stop the service, so while it runs (or its state cannot be read) repair leaves a
  differing `current/coforge-computer` and the `version` marker alone, a conservative choice (a
  renamed-over executable keeps its path on macOS, so such a process can still be found). The
  receipt fails `UPDATE_BUSY`.
- Nothing prunes `versions/`; a pruning step must keep the previous version for rollback.

## Modules

- `src/args.rs`: command-line parser and parser tests; produces typed command intent for `main.rs`.
- `src/main.rs`: command line. Calls `installation`, prints the
  result, maps outcomes to exit codes. No installation logic. Process tests in `tests/cli.rs`
  run the real binary against a scratch home, with no network.
- `src/lib.rs`: crate root; declares the library modules.
- `src/fetch.rs`: verified download. One HTTPS object, hashed as it arrives,
  optionally gunzipped under a byte cap, committed only after every check
  passes; plus the bounded in-memory read of a small metadata object. Follows
  no redirect and keeps no idle connections (every request opens its own).
  Tests in `src/fetch/tests.rs` (loopback HTTP, no network).
- `src/idle_timeout.rs`: the ureq transport wrapper that fails a transfer after
  a silent stretch (ureq has no per-read timeout).
- `src/digest.rs`: SHA-256 identities (size and lowercase checksum) of bytes and
  files, and the rule for a valid identity.
- `src/private_fs.rs`: private files and directories under the install root, and
  atomic replacement. Recursive directory creation with a mode (an existing
  directory keeps its own), a new file with an exact mode, a file replaced
  through a temporary sibling (fsynced, renamed, its directory fsynced), and the
  unique names of those temporaries. Tests in `src/private_fs/tests.rs` (real
  files).
- `src/update_error.rs`: the failures of preparing a version, carrying the
  product's `UPDATE_FEED_INVALID` (content), `UPDATE_DOWNLOAD_FAILED` (a transfer
  the feed could not complete: unreachable, reset, idle timeout, non-2xx status),
  `UPDATE_INTEGRITY_FAILED`, and `UPDATE_UNSUPPORTED_TARGET` codes
  (`upgrade-error-codes.json`).
- `src/manifest.rs`: what a valid release manifest is. Pure validation of
  `<version>/manifest.json` and the choice of one target's artifact; no I/O.
- `src/feed.rs`: the release feed client. Resolves `latest`, fetches and
  validates a manifest, downloads one version's binary and Pi image library
  into a directory through `fetch`, checked against the manifest, retrying a
  transient failure of any of these requests on the clock port. The size
  ceilings and the transfer checks it shares with `release_directory` are
  `pub(crate)` helpers here. Retry tests in `src/feed/retry_tests.rs`.
- `src/release_directory.rs`: a release read from a local directory (`--from-directory`), the
  same objects in the flat local-package layout, through the same caps and checks as `feed`.
  Tests in `src/release_directory/tests.rs`.
- `src/store.rs`: the version store under the install root. Stages a version in
  `.staging/` (sweeping what a killed run left there), renames it to
  `versions/<v>`, and verifies an installed version offline (`installation.json`
  schemas 2, 3, and 4). What changes the install root takes the machine
  mutation lock as a witness parameter and refuses a lock on another root.
- `src/prepare.rs`: makes a release version present in the store: resolve,
  download, verify, stage, install. The one place a release source and `store` meet.
  `ReleaseSource` is the seam: `Feed` and `ReleaseDirectory` implement it.
  Tests in `src/prepare/tests.rs` run a loopback release feed and a directory.
- `src/lock.rs`: the machine mutation lock, an SQLite RESERVED lock on
  `<install root>/machine-mutation-lock.sqlite` (rusqlite, bundled SQLite)
  that excludes the Computer's own `acquireProcessLock`. Tests in
  `src/lock/tests.rs` run that TypeScript function under Bun. A lock knows the
  install root it covers (`install_root`, `covers`).
- `src/journal.rs`: the recovery journal `<install root>/installer-transaction.json`. Written
  before an upgrade stops anything, cleared once the machine runs a known version; a journal
  that is still there makes every operation but `recover` refuse.
- `src/receipts.rs`: upgrade requests and receipts under `upgrade-results/`. Decides fresh,
  replay, or conflict for a request id, and commits each receipt write-once under the lock.
- `src/paths.rs`: install root, supervisor state directory, and shim
  directory, resolved from the home directory as the Computer does.
- `src/paths/node_path.rs`: `path.posix.join` and `path.win32.join` ported from
  Node's `lib/path.js` as Bun runs them, so `paths.rs` writes the same strings
  as the Computer's `paths.ts`.
- `src/version.rs`: which release version strings are acceptable, and their SemVer precedence.
- `src/active.rs`: the active version. Reads and writes `<install root>/active.json`, activates a
  version (POSIX: `current/` and the `active` and PATH shim links; Windows: a junction and a
  `.cmd` shim) and tells whether it is activated. It trusts the caller to have verified the
  version's bytes. Tests in `src/active/tests.rs`; they also emit `contract/rust/active.v1.json`.
- `src/current.rs`: the POSIX `current/` directory, the copy of the active version that runs:
  syncs it from a version directory and tells whether it is in sync. Tests in
  `src/current/tests.rs` (real files).
- `src/contract.rs`: serde types for every file and JSON shape shared with the
  product, split by concept into `src/contract/` and re-exported from `contract`, so callers name
  `contract::X`. `ArtifactIdentity` and `to_file_json` live here; the golden test helpers and the
  golden coverage list are in `src/contract/tests.rs`, each submodule's tests in its `tests.rs`.
- `src/contract/manifests.rs`: the product and installer release manifests, the feed list, and
  the release version cases.
- `src/contract/installation.rs`: `active.json`, `installation.json`, and the launchers.
- `src/contract/receipts.rs`: upgrade receipts and their outcomes, exit and error codes, and
  dead-process evidence.
- `src/contract/lifecycle.rs`: the JSON `coforge-computer __lifecycle` prints.
- `src/contract/machine.rs`: the machine mutation lock, service names, and paths.
- `src/clock.rs`: the clock and sleep port the bounded waits run through (virtual in tests).
- `src/service.rs`: OS service control of the Computer supervisor: state (not installed, stopped,
  running with the manager's pid), stop (waits until the manager has dropped it), install (registers
  the service definition the Computer reports, without starting it; launchd and systemd leave a
  file that already holds the same bytes alone), `install_may_end_running_service` (whether
  replacing a registration may end a running service: Windows only), start (waits for a process).
  One backend per manager in `src/service/` behind the `CommandRunner` port.
- `src/service/definition.rs`: what the backends share to register a definition: the manager
  check, the byte comparison with the file already in place, the atomic owner-only write, and the
  UTF-16 temporary file `schtasks` reads.
- `src/service/port.rs`: the `CommandRunner` port and `SystemRunner`, which runs a manager tool
  with a bound and kills it at the deadline.
- `src/service/error.rs`: `ServiceError`, each failure worded with what to run next.
- `src/service/launchd.rs`: the macOS backend, `launchctl` in the `gui/<uid>` domain; install writes
  the plist. Install tests in `src/service/launchd/install_tests.rs`.
- `src/service/systemd.rs`: the Linux backend, `systemctl --user`; install writes the unit under
  the home directory, then `daemon-reload` and `enable`. Install tests in
  `src/service/systemd/install_tests.rs`. `ProcessCgroup` (`OwnCgroup` reads
  `/proc/self/cgroup`) tells whether the caller runs inside the unit; other backends answer no.
- `src/service/windows_task.rs`: the Windows backend, the scheduled task through `schtasks` and
  `Get-ScheduledTask`; install is `schtasks /Create /XML /F`. Install tests in
  `src/service/windows_task/install_tests.rs`.
- `src/service/fakes.rs`: a scripted `CommandRunner` for the backend tests.
- `src/processes.rs`: the processes of the installed product executable: identity (pid, start
  time, executable), enumeration, and the SIGTERM, SIGKILL, verify-dead escalation after the
  manager's stop. One `ProcessTable` adapter per OS in `src/processes/`; the caller is excluded.
- `src/processes/linux.rs`: the Linux `ProcessTable`, read from `/proc`.
- `src/processes/proc_stat.rs`: parsing `/proc/<pid>/stat` and the `exe` link; compiled on every
  platform under test.
- `src/processes/macos.rs`: the macOS `ProcessTable`, through libproc.
- `src/processes/windows.rs`: the Windows `ProcessTable`, through Toolhelp and process handles.
- `src/processes/signals.rs`: SIGTERM and SIGKILL to one pid (Unix).
- `src/processes/fakes.rs`: a process table that plays out exits, kills, zombies, and pid reuse
  on the virtual clock.
- `src/lifecycle.rs`: the `ComputerLifecycle` port (protocol, status, and service-definition
  answers of a Computer executable), `reported_service_definition` (asks for the definition only
  when `protocol`'s `commands` lists it), and `Lifecycle`, which runs `coforge-computer
  __lifecycle` bounded and reads its versioned JSON. Tests in `src/lifecycle/tests.rs`.
- `src/switch.rs`: the switch of the active version, shared by upgrade and recovery: `Ports` (every
  port a transaction touches), `Target`, `Plan`, and `ActiveSwitch` (stop the supervisor and its
  processes, activate, register the `Target`'s service definition, restart, probe). It decides
  nothing about what to switch to and runs no Computer executable to learn a definition: the
  caller reads it before anything stops.
  `refusal_inside_service` refuses both operations when the caller runs inside the running service.
- `src/upgrade.rs`: the upgrade transaction (lock, journal, receipt, prepare, switch, roll back).
  Tests in `src/upgrade/tests.rs` (scripted lifecycle and service, real files and loopback feed);
  the service definition across upgrade, rollback, and recovery in
  `src/upgrade/tests/service_definition.rs`.
- `src/upgrade/preparation.rs`: everything an upgrade checks before its first change (the active
  version's health, supervisor management, the candidate, and, while the supervisor runs, the
  service definitions of both versions, read from their stored executables); a failure is a
  refusal with nothing changed.
- `src/upgrade/fakes.rs`: test doubles and fixture for the upgrade and recovery tests: scripted
  lifecycle and service, and an install root with versions `0.1.0` and `0.2.0` served by a
  loopback feed.
- `src/installation.rs`: the installation a command acts on. `Setup` (install root, release target,
  compiled feed) and the use cases `transaction`, `recover`, and `status`, which build the real ports
  (service manager, process table, clock, release source) for this machine. `ReleaseOrigin` picks
  the release source of a transaction: the feed, or a `--from-directory`.
- `src/status.rs`: the read-only status report (`status --json` field names) and its human lines.
- `src/compiled_feed.rs`: the release feed compiled into this build and the rule that accepts it
  (HTTPS, or a loopback `http://` build for end-to-end tests). Tests in `src/compiled_feed/tests.rs`.
- `src/request_id.rs`: generates the request id of an `install` (RFC 9562 version 4; unique, not
  secret). Tests in `src/request_id/tests.rs`.
- `src/recover.rs`: `coforge-computer recover`. Refuses from inside the running service, then
  settles the journal through `switch`, reading the definition of the version each attempt switches
  to before that attempt stops anything: keeps a recorded success or an already-active new version
  that settles, otherwise restores the previous version. Writes a receipt only when none exists;
  clears the journal only after settling. Tests in `src/recover/tests.rs`.
- `src/repair.rs`: `coforge-installer repair`. Verifies the selected immutable version, repairs
  the activation, and quarantines and redownloads a damaged payload without touching service
  processes; writes a repair receipt. Tests live with the module.
- `src/repair/service_definition.rs`: repair's registration of the active version's service
  definition after the activation is repaired; it never stops or starts the service.
- `src/test_support.rs`: test-only helpers shared by the modules' tests: a
  scratch directory, a loopback HTTP server (`src/test_support/loopback.rs`,
  which can script a path's first answers), a tiny release tree, and runners
  that repeat a test in a child process, killed after `CHILD_DEADLINE` (30 s).
