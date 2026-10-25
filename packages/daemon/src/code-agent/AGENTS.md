# code-agent instructions

Rules for the provider seam and adapters in `src/code-agent/`. They extend
`packages/daemon/AGENTS.md`.

## Provider seam

- `CodeAgentProvider` is the sole public runtime seam: it creates one-session `AgentSession` instances and owns usage and context reports, composed from provider-internal modules. `runtime-inventory.ts` composes discovery; `runtime-probe.ts` probes versions; `catalog-discovery.ts` and `<provider>/catalog.ts` own catalogs.
- The registry returns Providers, never lifecycle wrappers or forwarding adapters.
- Higher layers consume normalized status and Activity messages and must not
  parse Claude Code, Codex, Pi, or any other provider's output.
- Every shipped session exposes `hasLiveTurn` from native turn/admission state or its owned turn process.
  Never derive it from recent output or a timeout. Daemon filters idle-turn Activity and checks it before
  renewing Busy, except while a turn's background tasks still run; an unknown value never claims Idle.
- A Provider that knows why a launch cannot start throws a typed launch error from `contract.ts`
  (`RuntimeVersionUnsupportedError`, `RuntimeModelNotFoundError`, `ModelProviderSettingError`),
  keeping any SDK error as its `cause`. The Pi Provider maps the SDK's `PiLaunchError` policy
  codes here.
- Adapters emit only official display events and explicit lineage, never raw reasoning.
  Claude Code text/thinking come once per completed `assistant` block, its stream deltas only as
  `progress`; a block reporting a failed API request (`error` field, `API Error:`) is an `error`.
- A provider that streams a shell tool call's arguments feeds `ReplyIntentScanner` ([reply intent](../../../../docs/observability/reply-intent.md)), shell tools only; higher layers see only its neutral `reply-intent` events. Send targets are read in `send-command-target.ts`, never in display-only `tool-activity.ts`.
- A `notice-undelivered` for a turn comes before that turn's `completed`, and echoes the
  `deliveryIds` `notify` was given: the daemon settles tracked mentions on `completed`. Kiro
  waits, bounded, for the turn's steering outcome before reporting the turn ended.

## Runtime inventory and models

- Inventory external CLI providers from the Daemon's effective PATH at startup
  and after reconnect. Report Pi and the built-in CoForge Agent from their
  embedded SDK and version; never scan PATH for them.
- Translate persisted model and reasoning selections into each provider's
  native startup configuration.
- Bound every probe and catalog discovery wait with `withDeadline` (`@lrm/coforge-anvil`), never an
  uncancelled `Bun.sleep` race, whose timer keeps a stopped daemon alive. A catalog discovery
  gets `CATALOG_DISCOVERY_TIMEOUT_MS` per wait. Pi's in-process SDK call gets the network refresh
  cap plus one wait (`PI_CATALOG_DISCOVERY_TIMEOUT_MS`, derived from `PI_MODEL_REFRESH_TIMEOUT_MS`
  in `@coforge/agent`) because that refresh is capped separately and the resource loader runs
  after it. A CLI that fetches its list over the network has its own deadline next to its catalog
  reader (`opencode models --verbose`, `agy models`). Explicit refreshes force Pi and forbid Codex's
  disk fallback; offline or failed probes are omitted, logged as `code_agent_catalog:discovery_failed`,
  and never cached. Ordinary inventory retains its existing cache fallback policy.
- Report the maintained Claude Code model catalog when Claude Code is installed. Never launch the
  CLI to infer a dynamic catalog; its machine-readable initialization does not give a dependable
  list. `claudeStaticCatalog(version)` lists a pinned model only when the probed CLI meets the
  minimum `code.claude.com/docs/en/model-config` states for it
  (`CLAUDE_CODE_MODEL_MINIMUM_VERSION`); aliases stay, an unknown version keeps every model;
  efforts follow Raft's catalog (`opus`/`fable`/`sonnet` all; `haiku` none).

## Standing instructions

- Keep the standing CoForge Agent instructions in one provider-neutral source,
  `agent-instructions.ts`. `AgentProcessManager` builds them once per session
  and passes them through the required `AgentSessionOptions.instructions`.
- Keep transport guidance minimal: identity, `Current Runtime Context`,
  communication, on-demand context recovery, safety, and help. The fixed
  prompt budget is 3KB excluding dynamic identity data. Ordinary questions and untracked DM work need no Task or per-turn memory bookkeeping;
  only before a long task does the Agent note where it is in
  `notes/active-context.md` (not MEMORY.md) so it can resume.
  An inbox notice lists targets — `check --target` those and reply; do not
  read MEMORY.md first. Replies default to where the conversation is (top
  level, its thread, or a claimed Task's thread); a new topic or a thread's
  conclusion may go top level, a human-named place wins, and the thread-mismatch
  send confirmation defers to that default. Before implementing shared channel work, claim the original top-level message
  or existing Task. Only the successful claimant implements; peers may analyze
  or review in its thread.
  Feature workflows come from event output and the Manual, not the standing
  prompt. Manual get/search `--intent`/`--reason` are optional; deploy a
  compatible Web before upgraded CLI/Daemon, and roll clients back before the
  server. A check/read/resolve window that contains tracked Tasks includes
  one Tasks-manual pointer; ordinary messages do not.
- Only a trusted `workspace-assistant` launch identity appends `workspace-assistant-instructions.ts`, the platform playbook; ordinary Agent instructions retain their existing prompt budget. A launch identity that names the Workspace's apps adds `## Apps` (dynamic identity data, normalised by the SDK's `agent-launch-apps` and kept within its byte budget, stated to be reference data that grants no access). It names the apps and points at `coforge app list` and `coforge manual get apps`; how to use an app (`app token`) stays in the Manual. The Memory Agent never gets it.
- Every Provider injects them through the provider's native system or developer
  instruction mechanism: Codex app-server `developerInstructions`, the Claude
  Code system-prompt-file option, the CoForge Agent resource-loader
  system-prompt override, and Grok ACP `_meta.systemPromptOverride`.
- Current channel roles override names, previous sessions and local memory. Without current coordinator status or explicit human delegation, an Agent must not assign, chase or reprioritize peers. Coordination stays scoped to its channel and grants no extra permissions. Web annotates channel reads with current roles; launches preserve Agent-owned memory.
- Do not copy the text into a provider. Do not write `AGENTS.md` or `CLAUDE.md` into the user's
  Agent workspace for a provider that supports native injection.
- Deliver Message recovery bodies directly as turn input and App Inbox wakeups
  separately. Never append them to the standing instructions.
- When a session lacks older user-referenced context, the instructions direct the Agent to lexical
  `coforge message search`, then a target-scoped `message read --around`.

## Assigned skills

- `assigned-skills.ts` refreshes platform-owned skills on Agent launch using a
  content hash. Preserve edited or unknown same-named files. Exact known legacy
  hashes allow migration of pre-marker installs; retire only unchanged platform
  files and keep other files in their directories.
- Weekly-report conversation guidance lives in navigation; writing is reserved
  for platform extraction/Collect wakes. Shared communication and safety belong
  in `agent-instructions.ts`, not feature skills.

## Codex

- `codex/provider.ts` owns retry classification: `willRetry: true` notifications stay internal
  diagnostics; numbered stderr reconnect lines become informational `runtime_reconnecting` Activity.
- Codex Activity follows the reference Computer; MCP tool names match Claude's `mcp__<server>__<tool>`.
- Every app-server request is answered -32601 (`server-requests.ts`), from process start.
- Resume recovery (`thread-open.ts`): archived -> `thread/unarchive` once, then resume, else a fresh
  thread reported as replaced; active writer -> `session_in_use`; the missing-rollout match stays
  exact. An unnamed thread is named `CoForge · <agent name>`, best effort.
- `turn-signals.ts`: a completed turn with no evidence and a `systemError` status are errors
  (`codex_zero_evidence_turn_completed`); warnings, waiting and blank answers are logged only.

## Per-turn providers (Cursor, OpenCode, Antigravity)

- Cursor's partial-output framing rules are in [Anvil Cursor rules](../../../anvil/src/cursor/AGENTS.md).
- One child process per turn. Anvil `src/per-turn/session.ts` is their one `AgentSession` (state machine,
  input queue, interrupt, dispose, session identity and its reports, exit handling) and
  Anvil `src/per-turn/turn-process.ts` their one process wrapper. A provider adds `<provider>/turn-protocol.ts`
  (argv, environment, stdin mode, record mapping) and calls `createPerTurnSession` from its
  `provider.ts`, which keeps provider-wide concerns (usage, the version gate). The host injects environment composition and OS process ownership through `per-turn-host.ts`; never copy the Session.
- Composition, not inheritance: a difference is a `TurnProtocol` field or a `TurnReader` hook. Each
  one (`instructionsTurn`, `resumedIdentity`, `repeatedSessionId`, `identityReports`,
  `mintSessionId`, `sanitizeEnvironment`, `lostResume`, reader `end`) records an observed CLI difference. Check the real CLI before adding
  one or making two providers agree; the fixtures do not prove a binary.
- The session never parses provider output. A reader emits through the `TurnScope`, synchronously,
  so events keep the CLI's order. A turn's stdin mode is a CLI fact: `eof` where the CLI waits for
  stdin EOF (OpenCode, #652), `open` for Cursor (`eof` is unverified there), `line` for agy.
- `#spawnTurn` builds the process before it marks the turn running, so a spawn that throws leaves
  the session idle.

## Antigravity (`agy`)

- One headless process per turn. The prompt is one stdin line under
  `--input-format stream-json`, never argv. agy has no system-prompt channel,
  so a fresh conversation's first turn is the standing instructions alone.
- An unknown `--conversation` id is not an error in agy: it starts a new
  conversation. Compare the `init` frame's id with the requested one and
  re-bootstrap on a mismatch, or the Agent runs without its instructions.
- Never pass `SSH_CLIENT`, `SSH_CONNECTION`, or `SSH_TTY` to an agy turn,
  `agy models`, or `agy -p /usage`; agy switches to a file-based token store when it sees them. An
  explicit Agent override still applies.
- `antigravity/tool-call.ts` maps agy tool names to canonical tools and moves
  only verified argument fields; a `subagent` step is one `invoke_subagent`
  tool call with no input, since its prompt and local paths are not Activity.
- Account usage is `agy -p /usage --output-format json`, which answers without a turn.
  `officialGroups` keeps every returned group and bucket, including a weekly-only group, and
  `officialDescription` keeps `command.data.description`. `primary` and `secondary` remain the
  tightest group's 5-hour and weekly windows so an older Web still has two slots. Only an error
  naming sign-in or auth is `UsageUnavailableError`; a signed-out answer was never captured, so
  that match is assumed.
- The unknown-`--conversation` fallback, the `agy models` line format, and the
  SSH token-store switch are observed on agy 1.2.12/1.2.13, not documented.
  Re-check them when raising the version gate.

## Grok Build (`grok`)

Behavior, compatibility and native verification: [`docs/agents/grok-acp.md`](../../../../docs/agents/grok-acp.md).

- One owned `grok agent --no-leader --always-approve stdio` ACP process per session, with
  `_meta.yoloMode` on new and load; a permission request still asked gets `allow_once` only for the
  live session, else `cancelled`. Standing instructions replace Grok's system prompt as
  `_meta.systemPromptOverride` on new and load (not `rules`, which Grok ignores on load), so a
  resume runs the current ones. Keep native background tasks enabled. Resume requires `loadSession`.
- Only a `session/load` failing with `-32603` and `data.code === "FS_NOT_FOUND"` is replaced with a
  fresh session (`onSessionId(new, replaced)`); any other failure keeps the identity and fails launch.
- `--trust` covers only the Agent workspace: project skills and instructions load only from trusted
  folders; assigned skills live in `<Agent workspace>/.grok/skills`. Folder trust is a security
  boundary: get Frank's approval before widening it past the Agent workspace or dropping it.
- Idle input uses `session/prompt`; busy input uses `_x.ai/interject`. Native admission settles
  delivery. Only a refused interjection is resent as a prompt, never one whose answer was lost.
- `_x.ai/queue/changed` observes autonomous turn admission but never ends a turn; only
  `_x.ai/session_notification` `turn_completed` does. Ignore load replay for live Activity.
- Tool events carry native `toolName` and `rawInput`; `read_file.target_file` becomes `file_path`.
  Only terminal update `content` text is display output, never the `rawOutput` object. `cancelled`
  ends a call as an error; a `completed` shell call can fail via `rawOutput.exit_code`/`timed_out`.
- Catalog discovery uses ACP `initialize` then `_x.ai/models/list` without a session.
  Preserve each model's native reasoning choices; never invent common effort lists.

## Pi and built-in CoForge Agent

- Pi's Provider embeds the bundled Pi SDK and keeps the user's Pi models,
  settings, packages, extensions, skills, and authentication.
- An explicit Agent key overrides host authentication only in that session's
  in-memory model runtime. Never write it to disk or pass it in process arguments.
- Pi and the built-in Agent report `model_request_started` at the public SDK `agent.streamFunction` seam; lifecycle/progress is not a request start, and compaction keeps its own phase.
- Pi session files stay in the Agent's `.pi-sessions` directory. The built-in CoForge Agent uses
  its isolated bundled resources and `.builtin-sessions`; for skills, the Pi SDK still loads the
  user's `~/.agents/skills`, so that is the one Global root its Skills metadata reports.

## Skills metadata (`agent-skills.ts`)

- Discovery of Global and Workspace Skills metadata at provider-native roots
  is bounded and read-only.
- A metadata query never launches a provider, reloads a session, copies global
  skills, or changes the established runtime environment composition.

## Claude Code context report (`claude-code/context-report.ts`)

- It is a one-shot `/context` read that relies on undocumented headless
  behaviour. Run it against the Agent's own live session inside the Agent's
  workspace directory.
- Answer `no_session`, `unsupported`, `unparsed`, `timeout`, or `error` in
  plain words.
- Only the parsed structure goes on the wire; the raw Markdown never leaves the
  Computer. Format drift is a visible `unparsed` state, never a crash.
