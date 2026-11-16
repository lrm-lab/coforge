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
- An artifact's own page owns the window: its route sets `staticData.standalone`, which makes
  `AppShell` skip the sidebar, its queries and the tab bar (`useIsStandalonePage`); the gallery keeps
  the shell. The header reads, left to right, back link, title, version, who can see, home
  conversation (only when it is not the scope), who is viewing, then find, copy link and more. The
  back link returns to the gallery when the viewer came from it (`galleryEntryState`), else to the
  home conversation or the Workspace home (`homeLinkProps`).
- The open call records the viewer and answers with the roster, which seeds the viewers query; the
  presence chip reads it only after that (`useRecordOpen`).
- Scope names come from `useScopeLabels`; the Workspace scope is named by the Workspace
  (`av_vis_workspace` takes it), never a generic "everyone". A card's stored `preview` is a Markdown
  excerpt: render it with `MarkdownPreview`, clamped by its caller.
- `ConversationShareDialog` arranges its target and composer panes through a `ShareLayout`; the
  artifact send dialog supplies the two-pane one.
- The comments panel (`artifact-comment-panel.tsx`) and the files panel are one `panel` state and
  share `ArtifactSidePanel`; a comment is written on the version being viewed and, with a file
  open, on that file unless dismissed. On `artifact.comments.changed.v1` the cache fetches only the
  named comments (`syncCommentsChange`); the author's own mutation syncs itself and its event is
  skipped. The count comes from the document read. The composer reuses `ComposerField` with
  `mentionGroups="kind"` and the message composer's paste hook; its audience preview is keyed on the
  set of mentions, and its idempotency key changes with the request's content.
- Anchoring lives in `ArtifactCommentSurface`, which wraps a Markdown file (`text` anchors from a
  selection) or a code or CSV file (`lines` anchors, physical file lines: a CSV row's gutter shows
  the line its record starts on, header = line 1, and a quoted multi-line cell advances the count).
  The kind picks an adapter (`textAdapter`, `linesAdapter`: `build`, `locate`, `fromSelection`) once.
  The surface keeps one cached index per content revision (`useSurfaceIndex`: the observer only marks
  it dirty and runs only while comment mode is on or the panel is open) and publishes one
  `ThreadPlaces` map (comment id to found, changed or neutral) through `publishPlaces`; marker
  tops, panel order, the anchor line's status and reveal all read that map. Status is decided once
  per thread per viewed version: found; changed (the kind fits but the place is gone, e.g. a quote
  that no longer matches, shown as "the source changed"); missing (the file is not in the version,
  "not in this version"); neutral (the surface cannot place that anchor type or the row is beyond
  the shown cap: the place shows without a warning).
- A draft is one machine (`useAnchorDraft`: offered, composing, close) keyed by file and version;
  switching either discards it. Its target is `{ rect, highlight }`, never a `Range`, so the element
  picker can anchor into a sandbox frame through the same machine. A line selection is derived from
  one state and one delegated click on `data-anchor-select`; the selection is painted by the draft
  highlight, not per row. The comment list query lives once in the page; reveal and panel focus are
  consume-once handoffs (`useCommentHandoff`): one is dropped when a newer one replaces it or its file or comment mode moves away, and a reveal is consumed only once the surface has located it against a settled index (`useSurfaceIndex.settled`), so a partial render does not spend it. Stable
  values, the thread list, the handoffs and the places are separate contexts
  (`artifact-commenting.ts`). The composer's target is one union (`ComposerTarget`).
- Comment mode (the header toggle) is separate from the panel and its transitions live in
  `useCommentMode`: the toggle turns the mode on and opens the panel, or turns it off and closes the
  comments panel; closing the panel keeps the mode; "all comments" opens the panel only. Everything
  is drawn beside the content (the observed content node is never touched); highlights use the CSS
  Custom Highlight API (`lib/css-highlight.ts`). The text index skips `data-anchor-chrome` widgets
  (the code block's toolbar and previews), so a quote is what the reader sees; a quote shorter than
  12 characters is found only where some context still matches. An HTML page's frame is never asked
  for a selection.
