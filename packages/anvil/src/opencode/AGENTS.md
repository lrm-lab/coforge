# OpenCode adapter

These rules extend [`../../AGENTS.md`](../../AGENTS.md).

- Launch each turn with `opencode run --format json --auto`. The prompt is the last argv item.
  Resume passes `--session`. The model is `provider/model#variant`. The workspace is the process
  cwd and `PWD`. There is no `--dir` flag.
- Do not send standing instructions as a first turn. A fresh memory control session still runs one
  short turn (`Reply with ok.`) before it is returned, because the CLI names the session only after
  a run starts and conversation recovery reads that id first. Write the briefing to `instructions.md`
  in a private
  0700 temporary directory, mode 0600, and set `OPENCODE_CONFIG_CONTENT` to
  `{"instructions":["<absolute path>"]}` on every launch, including a resumed session. From 2.0.30
  on, OpenCode appends that file after the project's `AGENTS.md`. Do not set `agent.<name>.prompt`
  (that replaces the system prompt). Do not set `OPENCODE_CLI_CONFIG_CONTENT` (that overlays
  `cli.json`).
- If `OPENCODE_CONFIG_CONTENT` is already present in the Agent environment, the runtime
  `envVars`, or the process environment, refuse to start. Do not overwrite or merge it, and do
  not copy the user's OpenCode config.
- Delete the temporary directory when the session ends and when session creation fails after the
  directory exists. Do not write the instructions, `AGENTS.md`, or a config file into the Agent
  workspace.
- A managed config or a macOS managed preference ranks above this inline value. Whether OpenCode
  2.1.0 concatenates or replaces an `instructions` array from that later source is unverified.
- The CLI floor is 2.0.30, the first release whose instruction plugin loads absolute
  `instructions` entries, including `OPENCODE_CONFIG_CONTENT`. On 2.0.0 through 2.0.29 the child
  starts and drops the standing briefing. v2 remains the command and event contract. That append
  is not true for the whole 2.0 line.
