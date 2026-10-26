# Grok adapter instructions

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
