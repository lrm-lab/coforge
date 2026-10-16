# Agent runtime instructions

These rules extend the repository root instructions for `packages/agent`.

## Module map

- `src/runner.ts`: assemble Pi sessions, authentication, storage and native tools.
- `src/memory-agent-turn.ts`: own per-trigger Offer accounting and evidence-progress feedback without a retrieval count cap.
- `src/channel-turn-policy.ts`: settle idle channel turns and completed Offers through the Pi SDK finish hook, preserving queued input and prior hooks.
- `src/runtime-provider.ts`: bind provider authentication, proxy and TLS to each session.

Keep channel turn policy independent of model, benchmark answers and external scoring. A turn ending normally must leave the same session available for later input.
