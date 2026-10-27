# code-agent instructions

Rules for the provider seam and adapters in `src/code-agent/`. They extend
`packages/daemon/AGENTS.md`.

## Provider seam

- `CodeAgentProvider` is the sole public runtime seam: it creates one-session `AgentSession` instances and owns account usage and passive context observations, composed from provider-internal modules. `runtime-inventory.ts` composes discovery; `runtime-probe.ts` probes versions; `catalog-host.ts` supplies environment and process capabilities for Anvil's JSONL catalog runner; Anvil owns shared catalog deadline/error policy, and `<provider>/catalog.ts` owns each catalog.
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

- Runtime auth uses the same executable resolution and effective environment as discovery, preserving provider homes. Unknown/read/report failures log credential-redacted reasons at info; never raw process output or Error objects.
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

## DeepSeek Harness

- DSH remains unadvertised until native and UI acceptance. Its descriptor may resolve the
  executable without enrolling it in `externalCodeAgents`.
- DSH catalog probes use a private temporary cwd and the selected native home/profile. Native
  close does not delete persisted sessions; never delete their files ourselves. Reuse successful
  metadata within the process by install/config stat and effective-environment fingerprint.
  Neither credentials nor their fingerprint may be written to disk. Restart invalidates the
  cache; no periodic TTL refresh. Failed explicit refreshes retain old cache but report failure.
- ACP has no login flow. Existing native API-key/account configuration remains native; catalog
  availability is not proof of authentication, quota or successful generation.

## Command Code

- Command Code uses `cmd acp`. It has no ACP system-prompt field, so the host-supplied
  instructions are injected with a private `--mod` whose `appendSystemPrompt` hook returns
  the text read once at process start. A resumed session starts a new process and reads the
  briefing for that launch. The launch never includes `--safe-mode`, because that skips
  `--mod`. The temporary directory is removed when the session ends or the launch fails.
  Do not write those instructions into the Agent workspace. Discovery and launch both refuse a
  CLI below 1.87.2, the release that first loads `--mod` on `cmd acp`. A cached inventory entry
  is checked again the same way. An unparseable version is not refused.
- Skill metadata lists the Agent workspace and home only. Command Code CLI 1.87.3 help
  (`extendingBody`) discovers `.commandcode/skills` and `.agents/skills` in each place. A native
  project scan also requires a trusted workspace and walks up to the git root; this scan does
  neither. Assigned packs go to the native project root `.commandcode/skills`
  (`getProjectSkillsDir` on that CLI).
- The model catalog is `session/new`'s `model` config option, read by Anvil and cached with the
  other CLI catalogs. This version's web UI offers that model list only. It does not offer effort,
  because effort options exist only after the session switches model. A missing effort option
  leaves the model's own default. There is no usage scan. Permission requests are allow-once only
  for the active session, and all other requests are cancelled.
- Native Command Code rules live in [Anvil Command Code instructions](../../../anvil/src/command-code/AGENTS.md).

## Standing instructions

- Keep the standing CoForge Agent instructions in one provider-neutral source,
  `agent-instructions.ts`. `AgentProcessManager` builds them once per session
  and passes them through the required `AgentSessionOptions.instructions`.
- Keep transport guidance minimal: identity, `Current Runtime Context`,
  communication, on-demand context recovery, safety, and help. The fixed
  prompt budget is 3.5KB (3584 bytes) excluding dynamic identity data; the shared communication style fits without removing delivery or authority rules. Ordinary questions and untracked DM work need no Task or per-turn memory bookkeeping;
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
  system-prompt override, Grok ACP `_meta.systemPromptOverride`, and Command
  Code's private `--mod` `appendSystemPrompt` hook.
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

- Supply session, catalog, usage and auth host capabilities through `codex/host.ts`.
  Keep their environment composition and client identities distinct; auth CLI and
  app-server use the registry-resolved executable and the same effective environment.
- Native Codex rules live in [Anvil Codex instructions](../../../anvil/src/codex/AGENTS.md).

## Claude Code

- Supply session, auth, usage, reply-intent and read-only filesystem capabilities through
  `claude-code/`. Preserve their separate environment compositions and evaluation times.
- Native Claude rules live in [Anvil Claude instructions](../../../anvil/src/claude-code/AGENTS.md).

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

Native protocol, SSH filtering and quota rules live in [Anvil Antigravity rules](../../../anvil/src/antigravity/AGENTS.md). The host supplies session/command I/O and reads the live usage environment.

## Grok Build (`grok`)

Native session behavior is maintained in [Anvil Grok rules](../../../anvil/src/grok/AGENTS.md). CoForge reply-intent parsing and account-label masking remain host policies.

## Pi and built-in CoForge Agent

- Pi native session invariants and the shared SDK Session live in [Anvil Pi rules](../../../anvil/src/pi/AGENTS.md).
- `pi/provider.ts` keeps the built-in CoForge provider's product validation, native resource paths, memory policy and in-process proxy environment writes. Set those fields before calling Anvil's shared Session factory; never create a second Session state machine.
- Built-in catalog and release metadata remain host-owned.

## Skills metadata (`agent-skills.ts`)

- Discovery of Global and Workspace Skills metadata at provider-native roots
  is bounded and read-only.
- A metadata query never launches a provider, reloads a session, copies global
  skills, or changes the established runtime environment composition.
