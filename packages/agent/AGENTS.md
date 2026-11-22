# Agent runtime instructions

These rules extend the repository root instructions for `packages/agent`.

## Module map

- `src/runner.ts` is the importable library: it never starts RPC at import. `src/runner-main.ts` is the executable entry that starts the RPC runner; never import it from libraries.
- `src/pi-chat/`: own private workbench sessions, native history, turn checkpoints, approvals and working-directory operations on the stdio worker.
- `src/channel-turn-policy.ts`: settle idle channel turns and receipted channel sends through the Pi SDK finish hook, preserving queued input and prior hooks.
- `src/session-rotation.ts`: atomically rotate and prune oversized Pi/CoForge JSONL session transcripts at safe session boundaries.
- `src/cloud-computer-skills.ts` and `src/session-resource-loader.ts`: gate cloud-computer skill roots, cloud-only skills (`browser-login`, `cloud-computer-overview`), their diagnostics, and the cloud `APPEND_SYSTEM.md` block on `COFORGE_CLOUD_COMPUTER`; local sessions exclude them and safely prune migrated cloud-only skills from real `.pi/skills` directories without traversing symlinks.
- `src/runtime-provider.ts` binds provider authentication, proxy and TLS to each session.

Keep channel turn policy independent of model, benchmark answers and external scoring. A turn ending normally must leave the same session available for later input.
