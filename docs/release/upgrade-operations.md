# Upgrade operations

An upgrade is run by the separately released `coforge-installer`. Computer only
starts it, reads its receipt, and hands the result to the Daemon. The installer
owns the machine mutation lock, the recovery journal, download and verification,
service stop and start, process ends, activation, probing, and rollback. See
[`crates/installer/AGENTS.md`](../../crates/installer/AGENTS.md) for its command
line and exit codes.

## Starting an upgrade

`coforge-computer upgrade`, `coforge-computer install`, and the hidden
`__remote-upgrade` entry point (started by the Daemon for a server request) build
one operation `{ requestId, selection, origin }` at the process boundary
(`release/upgrade-operation.ts`). The request id is a UUID that names the receipt.

For each operation, `release/upgrade-runner.ts` then:

1. obtains `coforge-installer` fresh from the feed's `installer/latest`
   (`release/installer-launch.ts`). The download is verified and kept under
   `<install root>/installer/<sha256>/`, so an installer fix reaches the next
   upgrade without a Computer release. When the feed is unreachable, Computer
   uses its most recently used verified cached installer instead;
2. runs `coforge-installer upgrade --request-id <id> --version <selection>
   --caller-pid <pid>`, adding `--allow-downgrade` only when a CLI operation was
   given it. The caller pid is verified by the installer as the parent and is never
   stopped;
3. reads `<install root>/upgrade-results/<id>.result.json`.

If the installer cannot be obtained, or exits without a receipt, Computer writes
a failed receipt itself (with `UpdateError.code` when the installer could not be
obtained). The write is exclusive: an installer receipt that already exists is
never replaced. A CLI operation prints the installer's stderr and fails when the
result is not `succeeded`.

`coforge-installer install` is the same transaction with a generated request id;
the bootstrap scripts ([per-user installation](per-user-installation.md)) run it
for a first install.

## What the installer does

In order, with the machine mutation lock held throughout:

- refuses while the recovery journal `installer-transaction.json` exists (exit 3);
  request id replay returns the earlier outcome, and a reused id for another
  operation is refused (exit 2);
- downloads and verifies the target version, and checks it with
  `coforge-computer __lifecycle protocol`;
- requires the running version's `__lifecycle status` to be healthy before anything
  changes, and refuses a foreground externally supervised Computer. While the service runs, it
  also reads the service definition of the running version and of the target from their stored
  executables (`versions/<v>/`, `__lifecycle protocol` then `service-definition`, for a version
  whose `protocol` lists that command in `commands`). Either failing to print one refuses the
  upgrade with nothing changed: the switch installs the target's and the rollback the running
  version's, and neither may wait for a cold start inside the downtime;
- writes the recovery journal, then collects the product's processes (the caller
  excluded), stops the service through launchd, systemd `--user`, or Task
  Scheduler, and ends any survivor (SIGTERM, then SIGKILL, then verify it is
  dead). Their identities go into the receipt as `deadProcessIdentities`;
- activates the target, registers the target's service definition read above (a launchd plist
  written to `~/Library/LaunchAgents/`, a systemd user unit written to `~/.config/systemd/user/`
  and enabled, or a Task Scheduler task created from the XML), starts the service, and waits up
  to 60 s for the supervisor to report the target version under a new supervisor id. The
  definition is written before every start, so a plist that vanished while the job stayed
  loaded cannot strand the upgrade or its rollback; a file that already holds the same bytes is
  left alone. A Computer that does not list `service-definition` is started from the definition
  it installed itself, as before. Workspace health is not part of this check;
- on failure rolls back to the previous version, registering the service definition read for it
  before the stop, and records
  `UPGRADE_ROLLED_BACK` (exit 1). If the rollback cannot be verified, the
  operation ends unresolved with the journal kept (exit 3).

Exit codes: 0 succeeded; 1 failed (rolled back, or refused before any change);
2 held (another run holds the lock, or the request id belongs to something
else); 3 unresolved: an earlier upgrade could not be settled yet, run the same command again.

## Downgrade and recovery

There is no `rollback` command. Moving to an older version is
`coforge-computer upgrade --version <older> --allow-downgrade`.

`coforge-computer upgrade --dry-run` (with the same `--version` and `--allow-downgrade`) resolves
the target from the feed and reports what an upgrade would do under the rules below, then stops: no
prompt, no download, no installer run, no Workspace stopped. It exits 1 when the installer would
refuse the move and 0 otherwise, and it names the exact `--version` to apply, so a later `latest`
cannot change what was checked.

The installer decides this before anything changes. A target older than the active
version (SemVer precedence, so `0.1.0-e2e.2` is older than `0.1.0-e2e.10`) is refused
without the flag: the receipt is failed with `UPGRADE_DOWNGRADE_REFUSED`, the exit
status is 1, and the message names both versions and the command with the flag. The
same applies to `install` and to `latest` when the feed's pointer is older than the
installed version. A version that is not SemVer cannot be ordered, so it is refused
the same way. The same or a newer version, and a machine with nothing installed, need
no flag. `coforge-computer upgrade` and `install` pass the flag only from the CLI; a
server-triggered upgrade (`__remote-upgrade`) never does, so it refuses a downgrade.

Settling an unfinished upgrade and the installer's internal rollback are not gated: they restore a
version by design.

There is no `recover` command. Every installer operation (`install`, `upgrade`, `repair`, `start`)
settles an unfinished upgrade from the journal before its own work. When the journal says the
service ran, settling reads the definition of the version it is about to switch to before it stops
anything (a version that cannot print it fails that attempt, so it falls back to restoring the
previous version), and registers it before it starts the service. When it cannot settle, the
operation exits 3 without a receipt and says to run the same command again; meanwhile
`coforge-installer settle` retries by itself from a one-shot trigger, with a backoff (see
[Installer commands](installer-commands.md)). An operation inside the service's own unit cannot
settle (it would stop the caller); `start` goes on without settling there.

## Repair and start

`coforge-installer repair` always reconciles the active version's service definition, as the
upgrade does before a start, but never stops or starts the service (and on Windows leaves a
running task's registration as it is). A healthy installation whose definition was missing gets it
written and reports a repair; one whose definition is already in place stays
`REPAIR_NOT_NEEDED`.

When the service is not registered with the service manager, Computer's start paths run
`coforge-installer start` instead of registering it themselves. Under the
machine lock, with no request id or receipt, it reads the active version's service definition
from its stored executable, registers it, starts the service, and waits until the manager reports
it running; Computer then does its own handshake. The recovery journal does not block it, and it
stops nothing, so it also runs from inside the service's own unit (there it registers without
restarting and finds the service running). Exit 0 started; 2 another operation holds the lock; 1
for nothing installed, a Computer that cannot report its service definition (run
`coforge-computer upgrade`), or a registration or start failure.

## Daemon settlement

The Daemon settles the operation from the receipt, exactly as for any upgrade:

- the Daemon records each operation in `~/.coforge/daemon/bindings.json` as
  `upgradeOperations`, and only one operation may be pending per binding;
- a terminal result is reported to the server as `computer:upgrade_result`
  (`ComputerUpgradeResult`, additive, `protocol_major` unchanged) after the
  Workspace daemon's ready handshake. A Workspace daemon re-reads its config every
  5 s while it lists a pending operation, so one still running when its job fails
  (a failed download) reports the failure within one poll, retried until the server
  accepts it. A reported failure settles the request with
  reason `reported`; a reported success is corroborating evidence only, and the
  server still requires the Computer's own new identity and matching versions
  before an upgrade counts as complete;
- reported failure text is sanitized of absolute paths and credential-shaped runs
  at both ends.

Because the Daemon calls a server method that older deployments do not expose, a
Computer release carrying this behaviour must ship together with the Web
deployment that accepts it.

## Agents during an upgrade

An upgrade has no launch hold and no pause. The service stop stops busy Agents
with it. Unread messages come back from the cloud read boundary after the restart;
ACK rules are in the root [`AGENTS.md`](../../AGENTS.md) invariants.

## The restart runner hold

Stopping the supervisor gives each Agent about two seconds (a 1 s SIGTERM / 1 s
SIGKILL ladder), which is not enough for a tool call. `coforge-computer restart`
and the same `daemon:restart` local RPC from the web therefore first send
`daemon:hold` to the target Workspace daemons, and wait up to `RUNNER_HOLD_MS`
(30 s) for busy Agents to finish. A Workspace daemon that does not answer within
5 s counts as idle, and every failure proceeds with the restart, logging
`restart:runner_hold_quiescent` or `restart:runner_hold_expired`.

A held daemon stops admitting new turns. An inbound delivery is queued on the
existing per-Agent input queue rather than rejected, is never drained, and so is
never acknowledged; it is republished after the restart. No new Agent process is
launched. The hold is in memory only, so a restarted daemon is never born held.

`coforge-computer stop` deliberately does not hold: an explicit stop is immediate.

`coforge-computer restart --supervisor` restarts the Computer supervisor process
itself, through the platform's process manager (`launchctl kickstart -k` on macOS;
`systemctl --user reset-failed` then `restart` on Linux; ending and re-running the
scheduled task on Windows). It is mutually exclusive with `--workspace`. It engages
the same hold first, unless the supervisor cannot be reached at all, in which case
it restarts anyway. It refuses on a `foreground` externally supervised Computer.
