# Pi adapter instructions

- Pi's Provider embeds the bundled Pi SDK and keeps the user's Pi models,
  settings, packages, extensions, skills, and authentication.
- An explicit Agent key overrides host authentication only in that session's
  in-memory model runtime. Never write it to disk or pass it in process arguments.
- Pi and the built-in Agent report `model_request_started` at the public SDK `agent.streamFunction` seam; lifecycle/progress is not a request start, and compaction keeps its own phase.
- Pi session files stay in the Agent's `.pi-sessions` directory. The built-in CoForge Agent uses
  its isolated bundled resources and `.builtin-sessions`; for skills, the Pi SDK still loads the
  user's `~/.agents/skills`, so that is the one Global root its Skills metadata reports.
- The embedding host supplies environment composition, its default Pi agent directory, and reply-intent command recognition. Keep the shared SDK Session factory free of CoForge product setup; the daemon owns its built-in provider.
