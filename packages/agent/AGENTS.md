# Agent runtime instructions

These rules extend the repository root instructions for `packages/agent`.

## Module map

- `src/runner.ts`: importable Pi sessions, authentication, storage and native tools; never start RPC at import.
- `src/runner-main.ts`: executable entry that starts the RPC runner; never import it from libraries.
- `src/pi-chat/`: own independent cloud chat sessions, native history, durable turn checkpoints/recovery and native live updates and private working-directory file operations on the stdio worker.
- `src/agent-proxy-error.ts`: preserve proxy status, error codes and validated Offer publication outcomes.
- `src/memory-agent-turn.ts`: own per-trigger Offer accounting and evidence-progress feedback without a retrieval count cap.
- `src/channel-turn-policy.ts`: settle idle channel turns and completed Offers or published diagnosis reports through the Pi SDK finish hook, preserving queued input and prior hooks.
- `src/runtime-provider.ts`: bind provider authentication, proxy and TLS to each session.

Keep channel turn policy independent of model, benchmark answers and external scoring. A turn ending normally must leave the same session available for later input.
