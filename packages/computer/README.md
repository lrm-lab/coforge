# coforge-computer

`coforge-computer` is the sole installed native executable. It contains the
Computer CLI and Daemon runtime, supervises Workspace Daemons, and delegates
installation and upgrades to `coforge-installer`. Explicit re-authentication
uses the OAuth 2.0 device authorization grant:

```bash
mise exec -- bun run packages/computer/src/main.ts login
```

The command discovers `device_authorization_endpoint` and `token_endpoint`
from the server's RFC 8414
metadata. It prints the verification URL and user code, polls according to RFC
8628 (including `authorization_pending` and `slow_down`), saves the credential
without printing it, and saves the current server profile. Login does not query
Workspaces, bind a Workspace, or start a Workspace Daemon.

Official builds are bound to one environment: production uses `https://coforge.cn`, and staging
uses `https://staging.coforge.cn`. Login and setup do not expose a `--server` override. If an
existing profile names another environment, Computer fails before authentication, registration,
or Daemon startup rather than overwriting the profile.

Use `--json` for automation. Stdout contains exactly one JSON object; progress
and device authorization instructions use stderr. Success includes
`ok: true`, `server_url`, `binding_created: false`, and
`daemon_started: false`. Failures include a stable error `code`, a safe
`message`, and an actionable `hint`, and exit nonzero.

The canonical flow is `setup --workspace <slug>` using the command supplied by
the Workspace page. `COFORGE_SETUP_INTENT` remains available for automation and
end-to-end tests. Computer never lists or asks the user to choose a Workspace.
If no login credential exists, setup performs the OAuth device flow inline.
Setup looks up the selected Workspace with `workspace:get` and registers the
Computer with `computer:register` through the User-authenticated HTTPS RPC
transport; it does not use the OAuth metadata's Workspace endpoint.

Computer stores independent Workspace registrations. Adding a Workspace does
not stop or replace existing bindings. Each Workspace has its own daemon
instance and Agent runtimes. `setup --json`
keeps stdout to one stable result object and sends interactive prompts to
stderr. Setup registers the Computer and creates the server-side Workspace–Computer
registration through the approved CoForge RPC flow, then automatically starts (or reuses)
the local Daemon after a Unix Socket handshake. The user does not run
`coforge-daemon` separately.
Computer does not maintain a cloud WebSocket; each Daemon runtime owns its own
cloud WSS connection.

Use `coforge-computer start|stop|restart --workspace <slug-or-id>` to control
one binding through the resident Coordinator. Without a scope the command
targets all local bindings; global restart preserves stopped bindings.
Workspace restart replaces that daemon and its Agents, recovering sessions
selected by the cloud, without replacing other Workspaces or the Coordinator.
Normal installed operation uses the platform's user service manager and never
falls back to an unmanaged child process.

Use `coforge-computer logs` to print existing Computer log files and follow
new log records in real time. Press `Ctrl-C` to exit.

`coforge-computer install` and `upgrade` select `latest` or one exact version;
`coforge-installer` runs the transaction. Moving to an older version needs
`upgrade --version <older> --allow-downgrade`: without the flag the installer
refuses it (`UPGRADE_DOWNGRADE_REFUSED`, exit 1) and changes nothing, and it refuses
a version that is not SemVer the same way. `upgrade --dry-run` (with the same
`--version` and `--allow-downgrade`) reports the installed and target versions and
whether the installer would refuse the move, then stops without a prompt, a
download, or any change; it exits 1 when the move would be refused. See
[`docs/release/upgrade-operations.md`](../../docs/release/upgrade-operations.md).
`coforge-computer recover` finishes an upgrade that did not complete. All
versions and the sole Computer shim are installed for the current user; Daemon
is never exposed as a separate installed command.

Use `coforge-computer status` (or `status --json`) to see the install, the
supervisor, each Workspace binding, its Agents, and the locks in one place. It is
read-only. A Workspace that needs attention shows a detail line under it (a cloud
connection error, a pending or unsettled upgrade, a failed start or restart with the
command that retries it, or a degraded or parked state with how to recover).
`status --json` prints the same report as a single JSON object. An unhealthy
machine still exits 0; the one exception is an unreadable or corrupt
`~/.coforge/computer/install/active.json`, which exits 1 with
`STATUS_INSTALL_UNREADABLE`.

The executable runs on Bun and uses [Commander.js](https://github.com/tj/commander.js)
for commands, arguments, validation, generated help, suggestions, and version
output. Commander 15 is ESM-only and explicitly supports Bun. `picocolors` adds
TTY-safe emphasis without changing redirected output.

Computer and Daemon data use separate directories under the user's home
directory:

Computer credential storage can be relocated with `COFORGE_COMPUTER_CREDENTIALS_DIR`
(highest priority, used directly as the credential root) or
`COFORGE_COMPUTER_HOME` (credentials default to its `credentials` child). These
are state-directory controls, not Computer profiles. Without either variable,
credentials are stored under `~/.coforge/computer/credentials/<server>.json`.

| Platform | Computer directory                |
| -------- | --------------------------------- |
| Linux    | `~/.coforge/computer`             |
| macOS    | `~/.coforge/computer`             |
| Windows  | `%USERPROFILE%\.coforge\computer` |

Daemon data remains separate:

| Platform | Daemon directory                |
| -------- | ------------------------------- |
| Linux    | `~/.coforge/daemon`             |
| macOS    | `~/.coforge/daemon`             |
| Windows  | `%USERPROFILE%\.coforge\daemon` |

`FileCredentialStore` saves credentials as plaintext JSON in the credential
directory described above. It requests directory mode `0700` and file mode
`0600`, writes a temporary file, and renames it into place. File permissions
are subject to the host platform; this store does not use a system keychain.
A missing credential file means no saved login; an unreadable or invalid file,
or a failed save, returns `AUTH_CREDENTIAL_STORE_UNAVAILABLE`. Tokens are not
printed in login output or passed as command arguments.

Stable `machine_id` issuance and the initial cloud registration payload are
implemented in the Computer setup slice. Server-side validation and identity
proof remain pending.

## Local testing

Unit tests inject server URLs through application constructors. For local end-to-end
testing, set `COFORGE_E2E_WEB_URL` to the local Web URL and optionally
`COFORGE_E2E_CENTRIFUGO_ENDPOINT` to its separate WebSocket endpoint, then run:

```sh
mise exec -- bun scripts/e2e/build-computer-fixture.ts
```

This private build injects those endpoints into `.amp/e2e/bin/coforge-computer`
and `.amp/e2e/bin/coforge-daemon`, separate from release output. It does not add
a runtime server switch to official binaries. The existing
`scripts/e2e/run-computer-setup.sh` harness builds these fixtures, uses an isolated
HOME, and runs setup without `--server`; it still requires explicit
`COFORGE_E2E_ALLOW_DEVICE_AUTH=1` and `COFORGE_E2E_WORKSPACE_SLUG` for real local
authorization/registration. Never publish these test binaries.

Official references:

- [OAuth 2.0 Device Authorization Grant (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628)
- [OAuth 2.0 Authorization Server Metadata (RFC 8414)](https://www.rfc-editor.org/rfc/rfc8414)
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/0.8/)
- [Apple application support directory](https://developer.apple.com/documentation/foundation/url/applicationsupportdirectory)
- [Windows `FOLDERID_LocalAppData`](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
- [Bun single-file executables](https://bun.sh/docs/bundler/executables)
