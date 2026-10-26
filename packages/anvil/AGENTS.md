# Anvil instructions

`@lrm/coforge-anvil` owns provider-neutral Agent contracts, runtime adapters and their shared execution machinery. Keep it independent of daemon orchestration and platform implementations.

- Public contracts and exports belong here; daemon imports them by package name. Never import daemon modules, including through relative paths or aliases. `scripts/ci/anvil-boundary.test.ts` checks this direction.
- OS process trees and executable discovery are ports. The daemon supplies implementations explicitly; Anvil must not construct a platform default, read Workspace configuration, discover executables or read PATH.
- The host supplies per-turn environment composition through `PerTurnSessionHost.buildEnvironment`. Preserve when it runs and each provider's sanitization and overrides; Anvil never assembles the daemon's launch environment.
- Agent instructions, assigned Skills, Git hooks, runtime inventory and caches stay with the host. Adapters consume the prepared session options; they do not coordinate those policies.
- `src/per-turn/` owns the one Session state machine, input queue, interrupt/dispose, identity reports and child-process wrapper shared by per-turn adapters. Provider differences belong to `TurnProtocol` fields or `TurnReader` hooks; do not copy the Session or parse provider output there.
- Preserve provider behavior while migrating one contract or runtime slice at a time. Run the package checks and the daemon checks for every slice.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/contract.ts` | Provider-neutral sessions, provider and auth contracts |
| `src/runtime-auth-status.ts` | Shared runtime auth status values |
| `src/jsonl-process.ts` | Shared JSONL child protocol, record stream and process lifecycle with required host process ownership |
| `src/process-tree.ts` | Host process ownership ports |
| `src/catalog-discovery.ts` | Catalog wait deadlines and trusted discovery error projection |
| `src/catalog-command.ts` | Host catalog command execution port |
| `src/per-turn/` | Shared per-turn session and process execution |
| `src/version-gate.ts` | Shared version policy and required host version-reader port |
| `src/pi/` | Embedded Pi provider, native event/catalog projection and shared SDK Session factory with host capabilities |
| `src/antigravity/` | Antigravity per-turn protocol, tool events, version/catalog policy and usage parsing |
| `src/grok/` | Grok persistent ACP sessions, native turn events, catalog and usage through host capabilities |
| `src/kiro/` | Kiro ACP provider, native profile, events, version/catalog policy and usage parsing with explicit host ports |
| `src/opencode/` | OpenCode provider, turn protocol, version policy and catalog parsing |
| `src/cursor/` | Cursor turn protocol, provider and model catalog parsing |
| Other `src/` modules | Shared runtime Activity, error, JSON, stream and deadline utilities |

## Runtime instructions

- [Cursor adapter](src/cursor/AGENTS.md)
- [Grok adapter](src/grok/AGENTS.md)
- [Antigravity adapter](src/antigravity/AGENTS.md)
- [Pi adapter](src/pi/AGENTS.md)
