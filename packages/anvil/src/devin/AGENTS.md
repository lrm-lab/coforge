# Devin adapter

- `devin acp` is ACP v1 over stdio. Initialization and every app-server request belong here; the
  host supplies the process tree, the launch environment, version reads and account masking.
- The model list is `session/new`'s `model` config select: one option per variant, `value` the
  `model_uid`. Effort is the separate `thought_level` select, and its choices change after a model
  switch, so a session sets the model first and applies `runtime.reasoning` only when the returned
  select contains it. Models are not re-read from `devin models list`.
- Resume uses `session/load`. A session Devin no longer has (`-32016` with
  `data["cognition.ai/errorKind"]: "session_not_found"`) starts a fresh one and reports it as
  replaced (`onSessionId(newId, oldId)`); any other load failure surfaces. `sessionMode: "create"`
  always starts fresh.
- Permission mode is `bypass` (`Bypass Permissions`), applied through `session/set_mode`/the mode
  config. This matches the full-access policy every other CoForge runtime runs under (Codex uses
  `danger-full-access` with `approvalPolicy: "never"`); `ask`/`plan` are not offered.
- Devin has no system-prompt field on ACP. Standing instructions go into a private
  `.devin/rules/coforge-runtime-<uuid>.md` in the Agent workspace with `trigger: always_on`
  (Devin CLI docs, "Rules & AGENTS.md"). A project `AGENTS.md` is never edited, and a symlinked
  `.devin/rules` is refused. The file is removed on dispose and on process-exit cleanup. Each open
  sweeps CoForge rule files a crashed daemon left behind: older than 60 seconds and not held by a
  session of this process. Devin loads every always-on rule in the directory, so two concurrent
  sessions of one Agent each also see the other's (identical-source) instructions.
- No usage scan. Devin documents ACU billing and an enterprise Cost dashboard
  (`enterprise/devin-auth.mdx`); the CLI and ACP expose per-turn token usage only, no account quota.
  `RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[devin]` stays false rather than inventing a reading.
- Auth reads `devin auth status` for the login state and plan only; the person's name, email and
  credentials path in the raw report are never kept or logged. Login runs
  `devin auth login --force-manual-token-flow` on a pseudo-terminal (its code prompt reads only a
  TTY): the sign-in link is relayed, the person pastes the code in the Web, and it is typed into the
  CLI. That works whether or not they sit at the Computer, unlike the browser flow's localhost
  redirect. Windows has no pseudo-terminal here and falls back to plain `devin auth login`. Logout
  spawns `devin auth logout`.
- `devin --version` prints `devin <version> (<build hash>)`; the gate reads the first dotted-numeric
  token. `DEVIN_MIN_CLI_VERSION` is the release this adapter was exercised against; an older CLI is
  refused instead of run blind.
- Skills need no adapter work: Devin discovers the Agent workspace's `.agents/skills` (CoForge's
  layout) plus `.devin/skills`, `.cognition/skills`, `~/.config/devin/skills` and
  `~/.agents/skills`.
