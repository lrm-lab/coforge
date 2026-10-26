# DSH runtime

- Only `@lrm/coforge-anvil/dsh` exports this runtime. Keep the root entry free of DSH imports.
- Pin ACP to the verified `0.2.1-rc.2`. Unknown, unreadable, older and newer versions fail closed. Do not change the shared minimum-version comparator to handle this preview. Upgrading the pin requires fixture tests and native DSH acceptance first; a future stable range needs its own lower and upper bounds.
- Use `dsh --profile acp --patch <host path>`. DSH itself is user-installed; never run npx or install plugins from the adapter.
- The native plugin source and patch content are pure data. The host owns a private temporary directory, file modes, paths and idempotent cleanup. Instructions are a structured config string, never interpolated into executable JS or DSH's template personaPrefix. The plugin registers a section with `interpolate:false`; preserve literal braces and Unicode.
- Keep the user's DSH_HOME/profile/account for discovery and launch. Catalog exchange may create and close a native session; the host owns the temporary cwd and caching. Closing does not remove the persisted empty session.
- DSH has `session/resume`, not `session/load`. Never replace a failed resume silently.
- One native prompt at a time. Queued notices stay pending until submitted and confirmed by an assistant/tool update or a non-cancelled terminal RPC response. A submitted RPC error is an accepted failed turn, not an admission refusal. Cancellation is not acceptance. No admission timeout or retry after an unanswered submission; it may already be persisted. A transport loss must not emit `notice-undelivered`.
- On interrupt, reject queued input before `session/cancel`, wait boundedly for the active prompt to settle, and clean launch files. Dispose terminates the process immediately, without waiting for a natural turn end, and cleans files even on failure.
- Tool titles are native names in this preview. Preserve subagent/workflow/goal. Disable plugin-manager tools and plan-mode's interactive exit tool. Map only official ACP display events and never turn raw provider stderr into Activity.
- Shell command recognition remains a host policy, injected through the reply-intent scanner port.
