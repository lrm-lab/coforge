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
  Its per-method level floors are in `artifact-page-levels.ts`; each confirm-gated capability
  (`links`, `data`, `assets`) has its own decline count, and only the `data` consent is kept for
  the frame.
- Who can see an artifact is the home conversation, the Workspace, or anyone with the link
  (`use-artifact-visibility.tsx`); narrowing and link changes confirm, and a person never sees a
  fixed "everyone, always" rule. Sending to people who cannot read it is held until the sender
  chooses to widen, share by link, or send anyway.
- The viewer's actions live in the page header and the ⋯ menu (`artifact-more-menu.tsx`); show an
  action only when the viewer may do it.
- An artifact's own page owns the window: `isStandalonePage` (`components/layout/tab-home.ts`) makes
  `AppShell` drop the sidebar and tab bar there; the gallery keeps the shell. The header reads, left
  to right, back link, title, version, who can see, home conversation (only when it is not the
  scope), who is viewing, then find, copy link and more; a viewer's open must be recorded before
  the viewers roster is read (`useRecordOpen`).
- The Workspace scope is named by the Workspace (`av_vis_workspace` takes it); never a generic
  "everyone". A card's stored `preview` is a Markdown excerpt: render it with `MarkdownPreview`, or
  flatten it with `plainPreview` where one line is all there is.
