# Claude Code adapter

- Import native Claude from `/claude-code`. The neutral root and shared execution
  contain no native adapter implementation.
- Require explicit host ports. Environment composition, executable discovery,
  process ownership, file operations, account masking and CoForge command
  recognition belong to the host; never construct an ambient platform default.
- Session, usage and auth have different environment rules. Preserve their
  evaluation times and the session's reuse of one prepared environment on fresh
  fallback. Do not make these paths agree during a migration.
- Persistent Session owns identity, turn admission, notices, recovery and disposal.
  Retry missing history only on the exact native diagnostic before progress;
  preserve initialization and identity-report ordering.
- Emit completed assistant text/thinking once. Partial deltas mean progress;
  preserve raw API errors, explicit lineage and main-session filtering. Reply
  intent uses one host scanner per session and only shell tools.
- Observe tier/context at top-level results even when no live turn ends. Emit tier
  before computing context, and retain the session's tier de-duplication state.
- Usage has one overall deadline. Only unsupported capability permits the text
  fallback. The host cache retains its command/path/build key and success policy;
  do not add retries, TTLs or concurrency deduplication. Each structured exchange
  retains its owned-process cleanup.
- Auth retains the native version floor, trusted HTTPS hosts, pasted-code handling,
  cancellation, redaction and status classification. Never discover another CLI
  or launch a local browser behind the host's back.
- Native history layout and control records include observed internals. Keep their
  versioned comments and bounds; do not treat them as documented stable APIs.
  History reads are bounded and read-only. Secured workspace rereads stay behind
  the host's existing realpath, regular-file, size, no-follow and text checks.
- Prompt files are private host resources with idempotent removal. Preserve error
  cleanup, including failed construction, without writing instructions into a
  user's provider configuration or native session store.
- Tests use explicit fixture hosts and scratch storage. Never invoke a real
  provider generation or auth flow to verify a structural move.
