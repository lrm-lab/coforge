# Droid adapter

These rules extend [`../../AGENTS.md`](../../AGENTS.md).

Read [Droid ACP behavior](../../../../docs/agents/droid-acp.md) when changing Droid's session open, resume, model and effort, context usage or skills. Shared ACP rules: [Anvil instructions](../../AGENTS.md#acp-adapters).

- Standing instructions ride the CLI's own `--append-system-prompt-file`: the provider writes
  a private file (0700 directory, 0600 file) under the system temporary directory — never into
  the Agent workspace — and the session removes it when it ends. The alternative,
  `--append-system-prompt <text>`, would put the briefing in argv where any process table
  shows it.
- The CLI floor is 1.4.1 (`acp-version.ts`), the build the whole surface was verified on.
  `droid --version` prints a plain dotted version.
- Plan usage has no machine-readable surface (no ACP field, no CLI flag, no public endpoint),
  so `readUsage` drives the interactive TUI: spawn `droid` in a 160x40 PTY (`DROID_USAGE_SCREEN`
  — at the transport's 120-column default the panel collapses to unreadable bars), send
  `/limits`, Tab through the pool tabs, and parse the settled screens with `VtScreen`, the
  minimal VT buffer in `vt-screen.ts` — deliberately not a terminal emulator. Verified on
  1.5.0: Standard/Droid Core pools report 5-hour/Weekly/Monthly percentages with relative `↻`
  resets (minute precision, resolved against the capture instant; an unreadable phrasing omits
  `resetsAt`), Extra Usage reports a `$X.XX remaining` balance, and `You are using …` names the
  active pool. Any anomaly — missing header, window row, balance, or tab bar — throws
  unavailable rather than showing a wrong number; a sign-in screen is reauth. See `usage.ts`.
- Sign-in has no non-interactive command: the auth adapter runs the interactive TUI in a PTY,
  reads the device flow's sentence (`https://auth.factory.ai/device` plus a `XXXX-XXXX` code),
  and confirms completion by re-reading `droid doctor --json --checks auth`. A
  `FACTORY_API_KEY` in the launch environment overrides stored credentials and cannot be
  signed out (`still_logged_in`). See `auth.ts`.
