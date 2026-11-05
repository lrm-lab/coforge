# Artifact server modules

These rules apply to `src/server/artifacts/`. They extend
[`../AGENTS.md`](../AGENTS.md).

The artifacts module is written to be lifted into its own App later; today it
is a module inside the Web server (task #542). Three rules keep "moving it
out" a move, not a split:

- Code outside this directory imports only the public entries below, never
  another file here. `test/artifact-boundary.test.ts` enforces it.
- A conversation is reached only through
  [`../conversations/channel-read-access.server.ts`](../conversations/channel-read-access.server.ts):
  home access through `actorConversationAccess`, a `#name`/`@name` target
  through `visibleChannelIdByName`/`directConversationIdBetween`. Never the
  conversation tables or their predicates from here.
- Artifact data lives only in the `artifacts` and `artifact_*` tables. No table
  outside this module gains a foreign key to them.

## Public entries

- `artifact-composition.server.ts` — production wiring: `productionArtifacts`,
  `productionArtifactSandbox`.
- `artifact-access.server.ts` — the feature gate (`artifactsEnabled`) and the
  home/tier access predicates external callers need.
- `agent-artifacts.server.ts` — the Agent HTTPS API surface.
- `artifact-sandbox-config.server.ts`, `artifact-sandbox-http.server.ts` — the
  sandbox origin and its HTTP serving.
- `artifact-blob-sweep.server.ts` — the hourly blob sweep registration.

Everything else is internal: `artifacts.server.ts` (the `Artifacts` use
cases), the merge/read/write/revert/signals/documents/public-links/blobs
modules, and the sandbox implementation.
