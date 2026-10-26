# Antigravity adapter instructions

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
