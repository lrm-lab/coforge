# Agent runtime instructions

These rules extend the repository root instructions for `packages/agent`.

## Module map

- `src/runner.ts` is the importable library: it never starts RPC at import. `src/runner-main.ts` is the executable entry that starts the RPC runner; never import it from libraries.
- `src/pi-chat/`: own independent cloud chat sessions, native history, durable turn checkpoints/recovery and native live updates and private working-directory file operations on the stdio worker.
- `src/channel-turn-policy.ts`: settle idle channel turns and receipted channel sends through the Pi SDK finish hook, preserving queued input and prior hooks.
- `src/session-rotation.ts`: atomically rotate and prune oversized Pi/CoForge JSONL session transcripts at safe session boundaries.
- `src/runtime-provider.ts` binds provider authentication, proxy and TLS to each session.

Keep channel turn policy independent of model, benchmark answers and external scoring. A turn ending normally must leave the same session available for later input.
