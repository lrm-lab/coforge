# Agent runtimes

The Daemon runs each Agent on one code-agent runtime through the provider seam
in `packages/daemon/src/code-agent/` (rules in its `AGENTS.md`). A runtime
change is proven by a real turn on that runtime, not by its adapter tests,
which run against fixtures.

## Runtimes

`createCodeAgentProvider` (`packages/daemon/src/code-agent/registry.ts`) maps
the nine `RUNTIME_PROVIDER` values; the Web labels come from
`apps/web/src/features/agents/runtime-provider-display.ts`.

| Value | Web label | Native harness | Notes |
| --- | --- | --- | --- |
| `coforge` | CoForge | none of its own | Built-in Agent; needs a model API key ([e2e-openrouter-live](#openrouter-live)) |
| `pi` | Pi | `run-computer-setup.sh` → `native-browser.e2e.ts` | Pi + OpenRouter DeepSeek is the native browser scenario |
| `claude-code` | Claude Code | none | Uses the `claude` CLI on the Daemon's PATH |
| `codex` | Codex | none | Spawns `codex app-server` (`codex/provider.ts`) |
| `grok` | Grok Build | `packages/daemon/test/grok-native.e2e.ts` | See [grok-native](#grok-native) |
| `kiro` | Kiro | `kiro-native.integration.ts`, `apps/web/test/kiro-native.e2e.ts` | Consumes provider usage |
| `cursor` | Cursor CLI | none | Per-turn process (`code-agent/per-turn/`) |
| `opencode` | OpenCode | none | Per-turn process |
| `antigravity` | Antigravity CLI | none | Per-turn process |

"None" means no native harness exists: verify through the product with
[agent-turn](#agent-turn) on a Computer where that CLI is installed and signed
in, and say so in the report.

## agent-turn

One real turn on a chosen runtime, observed end to end. This is the default
proof for any Daemon or runtime change.

- **Reach**: a Computer attached to a local or staging Workspace
  ([computer-setup](computer.md#computer-setup)) whose runtime inventory lists
  the runtime, then an Agent on it ([agent-create](agents.md#agent-create)).
- **Drive**: send the Agent a DM asking for a unique marker reply, for example
  `Reply with exactly: VERIFY_<random>` ([conversations](conversations.md)).
  To exercise tools, ask it to run a harmless command or read a file in its
  workspace.
- **Success**, all of:
  - the reply with the exact marker appears as the Agent's message, and stays
    after reload (the canonical message, not an ACK or model completion);
  - the Agent's Activity tab shows the turn: a working/thinking state, tool
    rows such as "Running command…" with the command in the expanded row, then
    idle ([Activity web display](../../../../docs/observability/activity-web-display.md));
  - the avatar status returns from working to idle.
- **Observe locally**: `coforge-computer status` lists the Workspace's Agents;
  the Workspace Daemon's `logs/daemon/daemon.jsonl` holds lifecycle and
  `code_agent_*` records. Logs are diagnostics, not proof.
- **Traps**:
  - Rebuild and restart before the turn
    ([rebuild and restart](../../../../docs/agents/e2e-testing/rebuild-and-restart.md));
    an old installed binary answers otherwise.
  - Keep the reply marker free of sentence-ending punctuation; a model may drop
    a requested final period.
  - A newly created session can legitimately be empty; do not wait for a
    transcript before sending the first message.
  - Inventory scans the Daemon's PATH at startup and reconnect; after installing
    a CLI, use "Rescan runtimes" on the Computer page.
  - A provider key exported in a shell does not reach a running Daemon; import it
    into the service manager and `coforge-computer restart`.
  - OpenRouter upstream errors (for example an HTTP/2 body-stream error) are
    external failures; a passing rerun does not fix them, so record both.

## grok-native

- **Reach**: from `packages/daemon`,
  `COFORGE_GROK_E2E_COMMAND=/path/to/grok mise run test:file -- ./test/grok-native.e2e.ts`.
- **What it proves**: the real Grok CLI over ACP against a local model endpoint
  with an isolated `GROK_HOME`; no provider credits. Standing instructions, tool
  mapping, compaction, cancellation, live interjection, background follow-up,
  history after restart, and replacing a missing resumed session.
- **Artifacts**: `.amp/e2e/grok-native/report.json`, `acp-lifecycle.json`,
  `restore-missing.json`. Behavior and compatibility notes:
  [`docs/agents/grok-acp.md`](../../../../docs/agents/grok-acp.md).
- **Trap**: the test throws without `COFORGE_GROK_E2E_COMMAND`; it never skips.

## kiro-native

- **Reach**: from `packages/daemon`, `mise run test:file -- ./test/kiro-native.integration.ts`;
  the browser variant `apps/web/test/kiro-native.e2e.ts` runs after the managed
  E2E setup and requires `COFORGE_E2E_ALLOW_RESET=1` (disposable environment).
- **Traps**: needs a user-installed, authenticated Kiro and consumes usage. On
  macOS the temp directory is under the `/var` symlink, and the Kiro Provider
  rejects a linked agent profile directory (noted in the test header).

## openrouter-live

- **Reach**: `bun scripts/test/isolated-test-run.ts scripts/e2e/run-openrouter-live.sh` with a real
  `OPENROUTER_API_KEY` from the environment, in an Amp orb with the E2E services
  (`amp orb services ensure`). Runs `apps/web/test/e2e-openrouter-live.e2e.ts`.
- **What it proves**: canonical Agent replies in PostgreSQL for ordinary channel
  replies, muted-channel suppression, personal mention bypass, and
  followed-thread delivery, using production instructions.
- **Boundary**: in-process DaemonRuntime with an injected Pi Provider; it does
  not cover native Computer setup or process supervision
  ([coverage boundary](../../../../docs/agents/e2e-testing/coverage-boundary.md)).
- **Traps**: never replace the key with a placeholder or claim a model call from
  key presence alone.
