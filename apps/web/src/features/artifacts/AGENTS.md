# Artifact feature modules

These rules apply to `src/features/artifacts/`. They extend
[`../AGENTS.md`](../AGENTS.md).

- Browser code never imports `#src/server/…` directly; server access goes
  through this directory's `*.functions.ts` Server Functions only.
- `*.functions.ts` files are the feature's only server seam. They may import
  the artifact module's public entries (see
  [`../../server/artifacts/AGENTS.md`](../../server/artifacts/AGENTS.md)),
  never its internal files.
- People view and comment on artifacts; they never create, edit or save one. Do not add an editor,
  a draft or a save path here: an Agent writes an artifact through the Agent API.
- The page bridge (`artifact-page-bridge.ts`) treats everything a page sends as untrusted: it
  answers only its own frame at the exact artifact origin, enforces rate limits, the decline mute
  and the user activation itself (never the runtime, which the page controls), and posts only to
  that origin, never `*`. A new capability is a method of the bridge, offered in its handshake and
  documented in the Manual topic `apps/web/src/server/agents/manual/topics/artifacts.md`.
