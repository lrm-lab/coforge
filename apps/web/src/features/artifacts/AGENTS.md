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
  an artifact draft or a save path here: an Agent writes an artifact through the Agent API.
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
  `ThreadPlaces` map (comment id to found or neutral) through `publishPlaces`; marker tops, panel
  order, the anchor line's status and reveal all read that map. Comments follow their version: the page
  hands surfaces only the shown version's threads (`useShownThreads`), a surface places only drafts
  written on that version, and nothing is re-anchored across versions; an anchor it cannot place reads neutral, and a thread on another version reads
  `elsewhere` (`anchorStatus`). The panel groups open threads by version (`versionSections`: the
  shown version first, then newest), titled only when another version has threads; every reveal pins
  the thread's version first and fires once it shows (`use-thread-reveal.ts`); moving the pin
  anywhere else drops the pending reveal. A `?comment=` link reveals its thread the same way once
  the comment loads, so it opens the version the thread was written on.
- A draft is one machine (`useAnchorDraft`: offered, composing, close) keyed by file and version;
  switching either discards it. Its target is `{ rect, highlight }`, never a `Range`, so the element
  picker can anchor into a sandbox frame through the same machine. `DraftAffordance` is the one
  offer button and popover (file surface and frame layer alike); a rect never places either outside
  the container's box (`clampWithin`, measured in an effect when the offer is placed, not in render). A line selection is derived from
  one state and one delegated click on `data-anchor-select`; the selection is painted by the draft
  highlight, not per row. The comment list query lives once in the page; reveal and panel focus are
  consume-once handoffs (`useCommentHandoff`): one is dropped when a newer one replaces it or its file or comment mode moves away, and a reveal is consumed only once the surface has located it against a settled index (`useSurfaceIndex.settled`), so a partial render does not spend it. Stable
  values, the thread list, the handoffs and the places are separate contexts
  (`artifact-commenting.ts`). The composer's target is one union (`ComposerTarget`).
- Comment mode (the header toggle) is separate from the panel and its transitions live in
  `useCommentMode`: the toggle turns the mode on or off and never opens or closes the panel;
  "all comments" (the chevron) and a marker or thread link open the panel; closing the panel keeps
  the mode. Everything
  is drawn beside the content (the observed content node is never touched); highlights use the CSS
  Custom Highlight API (`lib/css-highlight.ts`). The text index skips `data-anchor-chrome` widgets
  (the code block's toolbar and previews), so a quote is what the reader sees; a quote shorter than
  12 characters is found only where some context still matches.
- Comments on an HTML page go through the bridge's annotation channel
  (`artifact-page-bridge-annotate.ts`); the host never touches the page's DOM. Host to frame:
  `coforge/annotate/mode`, `marks`, `focus`, `draft`. Frame to host:
  `coforge/notifications/annotate-selected|unselected|cancelled|found|activated` (and an
  `annotate-mode` acknowledgement the host ignores). The host keeps a gate as a filter: an `element`
  anchor is accepted once, only while a pick is open and the viewer is active; a `text` anchor only
  in comment mode and not while picking; `found` and `activated` name only ids the host sent, for the
  current marks revision; `ui/initialize` closes a pick and `ui/notifications/initialized` replays
  mode, marks and draft (both rate limited; a replay sends anchors clipped to the incoming limits).
  Everything arriving is validated again (`parsePicked`) with the anchor limits (selector 1000,
  label 120, quote 4000, context 64).
- The boundary is the person, not the gate. The page controls its frame, so the host cannot tell the
  runtime's pick from one the page forges (the activation gate only filters: picking starts on with
  comment mode, so a page can time a forgery right after the person turns comment mode on or presses
  "pick element"). A page can therefore choose what it
  reports as picked or selected. What holds: the composer always shows the anchor's label or quote
  (an element anchor with no label shows its selector, truncated) before the person sends, nothing
  is posted without the person sending, a page cannot start picking, read comments, or send one,
  and what the frame is sent is only ids, anchors, counts and labels built from its own text.
- Host state for a frame: `use-frame-offer.ts` (comment mode starts with picking on; the pill
  toggles it; text selection is offered when picking is off; an element pick composes at once
  through the offer's `autoCompose`; a pick the page cannot anchor ends with a message),
  `use-frame-marks.ts` (marks, found keyed by the revision the bridge echoes, places through
  `publishPlaces`, reveal; `activated` is ignored while a composer is open) and
  `artifact-frame-comment-layer.tsx`. Reports are provisional until the runtime reports after the
  page's load; marks past the 500 cap are never placed and read as neutral, and so does an element
  that is gone. `revealThread` for an `element` or `text` anchor on a framed entry focuses the mark
  and leaves the page open; a `lines` anchor opens the source view.
- Comment drafts are private and server-held (`use-comment-drafts.ts` is the one store;
  `use-submit-drafts.ts` owns send; both run under the store's one `exclusive` lock and busy state,
  so a send blocks draft edits and the reverse). The provider `artifact-drafts-provider.tsx` splits a
  state context (`useCommentDrafts`) from a stable actions context (`useCommentDraftActions`). The
  composer saves a draft; once one exists, saving is its primary action, and its save and send
  buttons sit in the composer box beside the image button. The review pill
  (`artifact-review-pill.tsx`) is the one floating tool bar: pick (HTML), undo and redo (a 60-step
  reducer, `artifact-draft-history.ts`, replaying server operations; drafts with images are not
  recorded; a step the server refuses for good is dropped with its toast, a transient failure keeps
  it; a restored draft keeps its creation time), discard all, send N. Mod+Z, Shift+Mod+Z and Mod+Y
  act only outside text fields and modal dialogs, ignore handled events, and prevent the default
  only when they act. Draft markers are dashed
  and uncounted (`data-draft-marker`; the frame's marks carry `draft: true`); a click opens the draft.
  A refused send opens the pending panel with the failing draft outlined. `?review=<id>` filters the
  panel to one review through the existing review read.
