# Command Code runtime

- Launch the user-installed `cmd acp` process through `JsonlProcess`; the host owns cwd, environment and process trees.
- Command Code ACP has no system-prompt field. Standing instructions go through a private session mod: `--mod <path>` and an `appendSystemPrompt` hook. The mod file and the instructions file live in a 0700 temporary directory, mode 0600, and are deleted when the session ends, when startup fails, or when a later error closes the process. Nothing is written into the user workspace or the user's Command Code config.
- The mod factory reads the instructions file once and caches that string. `appendSystemPrompt` returns the cache on every turn. One `cmd acp` process does not see a new briefing; a resumed session starts a new process, a new directory and a new read, so it gets the briefing generated for that launch. Reading again on every turn would change the system-prompt bytes and break the prompt cache. The cache stays in the factory closure, not in `modState`: `modState` is stored with the native session and would replay an older briefing after resume.
- Never pass `--safe-mode`. It loads built-in mods only and skips `--mod`, so the standing instructions would silently disappear. A user setting `mods.disableAll` skips `--mod` the same way. CLI 1.87.1 and earlier ignore `--mod` on `cmd acp`; 1.87.2 is the first release that loads it (Command Code changelog). Discovery omits a confidently lower version, and a launch checks again before spawn. An unparseable version is not gated. The mod factory writes a `loaded` marker after it reads the instructions; if that marker is missing once `initialize` returns, the session fails instead of continuing without the briefing. The error names both an older CLI and `mods.disableAll`.
- Preserve ACP session identity, resume, prompt, cancellation and request-permission semantics. Only the active session may receive `allow_once`; otherwise answer `cancelled`.
- Do not invent model catalogs, usage readers, yolo/trust flags or provider-specific wire extensions.
- `cmd status --json` is the only safe auth probe. Human `cmd status` writes "Not authenticated" on stderr, which the probe does not read. Exit 0 is logged in and shows no account; `authenticated: false` is logged out. `cmd auth status` starts interactive login; the auth adapter never invokes it. Login and logout remain terminal-only.
- `session/new` and `session/resume` pass `mcpServers: []`. This version does not start host MCP servers, the same as Grok and DSH. Do not send SSE.
- ACP tool titles are display labels (`Read: <path>`, `Fetch: <url>`), from CLI 1.87.3 `toolTitleFor`. The activity name comes from `toolKindFor` (`read` → `read_file`, `edit` → `edit_file`, `search` → `grep`, `fetch` → `web_fetch`). An execute tool with a string `command` is `shell_command`. A title is kept only when it is a bare tool name (`powershell`). A `Label: argument` title never becomes the activity name.

## Real-account acceptance

These need a signed-in `cmd` and are not covered by the fixture:

1. Put one checkable sentence in the standing instructions and confirm the reply follows it. This is the first acceptance check; the fixture only proves the mod file and the launch arguments.
2. Logged-in `cmd status --json` (exit 0, `authenticated: true`). The adapter shows no account. The `user` field is ignored.
3. `session/new` and `session/resume` model or config lists, and one real tool permission request.
