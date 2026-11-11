# Anvil instructions

`@lrm/coforge-anvil` owns provider-neutral Agent contracts, runtime adapters and their shared execution machinery. Keep it independent of daemon orchestration and platform implementations.

- The root entry exposes provider-neutral contracts, errors, projections and tools only. Import each native runtime from its named subpath (the `exports` map in `package.json`) and shared process/session implementations from `/execution`. Never re-export these implementations from the root or import them into neutral modules.
- Public contracts and exports belong here; daemon imports them by package name. Never import daemon modules, including through relative paths or aliases. `scripts/ci/anvil-boundary.test.ts` checks this direction.
- OS process trees and executable discovery are ports. The daemon supplies implementations explicitly; Anvil must not construct a platform default, read Workspace configuration, discover executables or read PATH.
- The host supplies environment composition through each provider runtime host's `buildEnvironment`. Preserve when it runs and each provider's sanitization and overrides; Anvil never assembles the daemon's launch environment.
- Agent instructions, assigned Skills, Git hooks, runtime inventory and caches stay with the host. Adapters consume the prepared session options; they do not coordinate those policies.
- `src/acp/` owns the one ACP connection and session state machine shared by the ACP adapters. A runtime declares its differences in `AcpRuntimeProfile` (arguments, notifications, configuration, wording) and `AcpSessionProfile` (authentication, session open, turn projection, insertion, admission deadline); do not copy the connection or the session into an adapter.
- `CodeAgentProvider.reportsCompaction = true` is claimed only by an adapter whose provider is observed to emit `compaction-finished`: the declaration enables the daemon's context ledger, which lets a read leave out text that a silently compacted context no longer has. `packages/daemon/test/provider-compaction-declaration.test.ts` fails a claim whose adapter does not emit. ACP adapters advertise the (UNSTABLE) `clientCapabilities.session.compaction` on `initialize` — the one place `src/acp/connection.ts` assembles it — and translate `compaction_update` into started/finished/interrupted without declaring: the event still re-briefs the Agent's memory, and no ledger is enabled. An agent that never sends one stays unreported rather than guessed.
- Preserve provider behavior while migrating one contract or runtime slice at a time. Run the package checks and the daemon checks for every slice.

## Module map

| Path                                                        | Boundary                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/contract.ts`, `src/runtime-auth-status.ts`             | Provider-neutral sessions, provider and auth contracts                                                                |
| `src/execution.ts`, `src/jsonl-*.ts`, `src/catalog-*.ts`    | The explicit public entry for JSONL/ACP catalog execution and its shared process, error and discovery policy           |
| `src/process-tree.ts`, `src/version-gate.ts`                | Host ports for process ownership, terminal transport, cleanup deadlines and version reads, plus shared version policy  |
| `src/acp/`                                                  | Shared ACP connection, session state machine, profile and turn projection contracts                                   |
| `src/stderr-*.ts`, `src/transcript-tail.ts`, `src/local-session.ts`, `src/launch-log-identity.ts` | Bounded, credential-redacted stderr excerpts, transcript tails, local Session handoff projections, and the launch's log identity |
| `src/<runtime>/` (one per runtime in the list below)        | One native runtime: its session, events, catalog, auth and usage behind host capabilities                             |
| Other `src/` modules                                        | Shared runtime Activity, error, JSON, stream, deadline and text-projection utilities                                  |

Runtime directories: `pi`, `antigravity`, `dsh`, `grok`, `command-code`, `kiro`, `opencode`, `cursor`, `codex`, `devin`, `droid`, `claude-code`.

## Runtime instructions

- [Cursor adapter](src/cursor/AGENTS.md)
- [OpenCode adapter](src/opencode/AGENTS.md)
- [Grok adapter](src/grok/AGENTS.md)
- [Command Code adapter](src/command-code/AGENTS.md)
- [DSH adapter](src/dsh/AGENTS.md)
- [Antigravity adapter](src/antigravity/AGENTS.md)
- [Pi adapter](src/pi/AGENTS.md)
- [Codex adapter](src/codex/AGENTS.md)
- [Devin adapter](src/devin/AGENTS.md)
- [Droid adapter](src/droid/AGENTS.md)
- [Claude Code adapter](src/claude-code/AGENTS.md)

## ACP adapters

Rules shared by every ACP adapter; each runtime file keeps only its own codes and paths.

- A `tool_call_update` ends a call only through `acpToolUpdateEnded`; a status the set misses leaves the call open forever and suppresses stalled recovery.
- Resume is `session/load`. Only the runtime's own stored-session-gone answer (its code is in the provider file) is replaced with a fresh session reported as `replaced` (`onSessionId(newId, oldId)`); any other load failure surfaces. DSH has `session/resume` instead and never replaces a failed resume.
- A runtime without `session/cancel` (Cursor and Droid answer `-32601`, Antigravity leaves it unimplemented, OpenCode is not relied on) interrupts by process disposal, and the daemon relaunches on the same session id.
- A terminal RPC failure after prompt submission is an accepted failed turn, never an admission refusal.
- Model and effort apply through `session/set_config_option` after the session opens. `runtime.model` fails with `RuntimeModelNotFoundError` when the select lacks it; a missing effort option leaves the model's own default, and a present option that lacks the value fails.
- Instruction files an adapter writes for a CLI are private (0700 directory, 0600 file) and removed when the session ends or the launch fails.
