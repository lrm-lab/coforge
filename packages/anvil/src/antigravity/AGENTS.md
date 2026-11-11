# Antigravity adapter instructions

Read [Antigravity ACP behavior](../../../../docs/agents/antigravity-acp.md) when changing Antigravity's session open, resume, steering, catalog or usage. Shared ACP rules: [Anvil instructions](../../AGENTS.md#acp-adapters).

- Launch floor `agy --version >= 1.5.0` (`acp-version.ts`), the first release shipping `agy acp`.
  A launch asserts `agentCapabilities._meta.antigravity.systemPrompt.append` on `initialize`
  (verified on 1.5.0) and refuses with `UnsupportedOptionError` when absent — no fallback. The
  version gate also runs before catalog discovery spawns a process; a below-floor agy is an
  upgrade prompt, not a failed launch, and an unreadable version never gates.
- Auth is `agy_acp_server`'s own OAuth in `~/.gemini/antigravity-acp/`, never `agy` CLI's.
  `authenticate` (`oauth-personal`/`oauth-business`) launches the server's browser flow on a
  short-lived `agy acp` process — never the running Agent session — and `logout` clears it;
  `session/new` and `session/load` `-32000 "Authentication required"` are `runtime_login_required`,
  `-32800` is a cancelled sign-in. A Computer without a desktop (`canOpenBrowser`: Linux needs
  `DISPLAY`/`WAYLAND_DISPLAY`, `COFORGE_COMPUTER_CLOUD=1` never qualifies) signs in through
  `agy acp --login` instead (`auth-terminal.ts`): the adapter probes `agy acp --help` for the
  flag, relays only an `accounts.google.com` link as `auth_url`, feeds the pasted code or
  redirect URL to the child's stdin, and re-verifies with the `session/new` probe after exit 0.
  Only `oauth-personal` has this path — headless `oauth-business` is refused as before. On macOS
  reached over SSH the browser flow still starts — the attempt fails only at the five-minute
  timeout, which is by design. The credentials
  stay on the server's side: the adapter never reads, stores, or logs them. A person who
  instead SSHes in and runs `agy acp --login` by hand gets agy's file-based token store when
  the machine has a credential manager, while the Daemon's SSH-stripped environment reads the
  keyring store — the two logins do not share credentials there.
- `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY` never reach an `agy` process: agy switches to a
  file-based token store when it sees them (logs "Using file-based token storage because %s
  detected"; not in the public docs). The Daemon strips them from inherited and declared inputs
  before an Agent's own overrides; an explicit override still applies.
