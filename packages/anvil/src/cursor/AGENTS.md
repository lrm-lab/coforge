# Cursor adapter

These rules extend [`../../AGENTS.md`](../../AGENTS.md).

Read [Cursor ACP behavior](../../../../docs/agents/cursor-acp.md) when changing Cursor's session open, resume, steering or model catalog.

- A launch resolves `runtime.model` + `runtime.reasoning` to a listed composite id
  (`model-variants.ts`) and sends it through `session/set_config_option` — never a composed
  `name[effort=x]`: the server accepts only listed values and answers `-32602
"Invalid model value"` for anything else, verified on 2026.10.22.
- Standing instructions ride cursor's own rule channel: a private
  `.cursor/rules/coforge-agent.mdc` file in the Agent workspace (file 0600, removed on cleanup;
  a launch that creates the directory makes it 0700 and takes the empty dir back down), because
  `cursor-agent acp` exposes no env or config overlay — the command is hidden and takes no
  options. The filename is fixed so a daemon crash cannot stack a second always-on copy; the
  launch also adds the file to `.git/info/exclude` when the workspace root itself is a
  repository (worktree `commondir` included) — that writes repository metadata. Never send
  the briefing as a first `session/prompt`: that lands it in the conversation.
- A Memory Agent cannot run Cursor: its per-conversation sessions share one workspace with
  different briefings, one rules file cannot hold them, and cursor reads every always-on rule.
  `createAgentSession` refuses `options.conversation`/`memoryControlSession` with
  `RuntimeMemoryUnsupportedError` (`runtime_memory_unsupported`).
- Known limit: a base name with several variants at one effort resolves to the first listed —
  `fast=true`/`context=` alternatives of that effort are not reachable through `runtime` alone.
- Auth is the CLI's own `cursor-agent login`; ACP has no login flow and `authMethods` names
  `cursor_login` only. `CURSOR_API_KEY`/`CURSOR_API_ENDPOINT` stay the process environment's
  business.
