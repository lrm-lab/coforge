# Installer command line

The commands, output and exit status of `coforge-installer`; what the crate does is in
[`crates/installer/AGENTS.md`](../../crates/installer/AGENTS.md).

- `coforge-installer install --version <latest|X.Y.Z> [--from-directory <dir>]`: the first install.
  The same transaction as `upgrade`, with a generated request id.
- `coforge-installer upgrade --request-id <uuid> --version <latest|X.Y.Z> [--caller-pid <pid>]
  [--from-directory <dir>]`: one request. The id must satisfy `contract::is_request_id`; a replay of
  a finished id prints the same outcome. `--caller-pid` is the `upgrade` command that launched this
  installer, verified as its parent and never stopped.
- `--from-directory <dir>` (install and upgrade) takes the release from a local directory instead of
  the feed: `manifest.json`, `coforge-computer.gz` (this target's gzip), and `photon_rs_bg.wasm`, flat
  in one directory, the layout of the Computer's local package. It needs a concrete version, never
  `latest` (usage error, exit 1). Every check the feed path makes applies. It is for local builds
  (`scripts/`), not for users.
- `--allow-downgrade` (install and upgrade): lets the target be older than the
  active version. Without it, a target that orders below the active version by SemVer precedence
  (`version.rs`) is a failed receipt, `UPGRADE_DOWNGRADE_REFUSED`, exit 1, decided after the target
  resolves and before anything changes; a version that is not SemVer cannot be ordered and is refused
  the same way. The same or a newer version and a machine with nothing installed are never gated.
  The flag is not in the request record, so a replay ignores it. Settling an unfinished upgrade and rollback are not gated.
- There is no `recover` command. `install`, `upgrade`, `repair` and `start` settle an unfinished
  upgrade (the journal) first, with the same caller rules as their own work; one that cannot be
  settled ends the operation with exit 3, no receipt, and "Run the same command again". `start`
  settles a journal the same way before it starts the service (a refusal inside the service's own
  unit starts as before; a recovery that fails fails the start).
- `coforge-installer repair [--version <v> | --channel main|latest] [--yes] [--allow-downgrade]
  [--json]`: under the machine lock, repairs the active installation without stopping the
  service. Healthy payloads only need the activation recreated; a damaged payload is quarantined
  and downloaded again through the manifest/checksum pipeline. It always reconciles the active
  version's service definition, even for a healthy installation (a no-op when the file already
  matches; on Windows only when the task is not running); one it cannot read or register fails
  the receipt, the repaired activation stays. Nothing to do (activation healthy, definition in
  place or unreported) is a held `REPAIR_NOT_NEEDED` receipt; any repair, a registered definition
  included, is `outcome: "repaired"`. Replays are supported. A running service's differing
  executable is left alone: the rest is repaired, then the receipt fails with `UPDATE_BUSY`.
- `coforge-installer start`: registers the active version's service definition and starts the
  service, for `coforge-computer start` when its service is not registered. It takes no
  arguments: it stops nothing, so it has no caller to spare. No receipt; see `start.rs` in
  [`src/AGENTS.md`](../../crates/installer/src/AGENTS.md).
- `coforge-installer status [--json]`: read-only, no lock. `--json` field names are documented in
  `src/status.rs`. `--version` prints the crate version.
  Output: each stage line is `==> <stage>` on stdout, flushed as it happens (stderr in JSON mode). A succeeded install,
  upgrade, or repair ends with `CoForge Computer <version> is active.`. A refusal or a failed
  receipt's message goes to stderr as `coforge-installer: <message>`, or
  `coforge-installer: <CODE>: <message>` when the receipt has an `errorCode`. A feed retry first
  prints `coforge-installer: retrying <object> in <n>s
  (attempt <k> of 3): <error>` to stderr. A feed request that failed 3 times ends its message with
  `(3 attempts; proxy configured|proxy bypassed|no proxy)`; bypassed: `NO_PROXY` exempts the feed.
  Exit status (`contract.rs`): 0 succeeded, 1 failed, 2 held (lock or request conflict), 3 unresolved
  (an earlier upgrade could not be settled yet: run the same command again; or a rollback failed).
  The release feed is compiled in (`src/compiled_feed.rs`): production defaults to
  `https://releases.coforge.cn`; plain HTTP is allowed only for loopback end-to-end tests. No command
  takes a feed.
