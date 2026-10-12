# Records (weekly reports)

These rules also cover `src/server/records/`.

- Workspace Records (weekly reports) belong to `features/records/` (list/detail,
  settings, stats, side comments, and Server Functions) and
  `server/records/record-catalog.server.ts` (cycles, reports,
  templates, favorites, notes, and comments). Persistence is Prisma under
  Workspace membership. Report bodies use lightweight outline JSON keyed by
  template-dimension tabs. Side panels retain platform comments and Collect cards alongside the private
  assistant conversation.
  The weekly-report assistant's on-demand reads reuse `RecordCatalog` through
  Agent HTTPS `POST /api/agent/v1/weekly-reports`, authorized as the assistant owner User.
  Multi-Computer collect belongs to
  `server/records/weekly-report-collector.server.ts` (per-Computer Collector
  bindings) and `server/records/weekly-report-collect-run.server.ts` (narrow
  Collect Run ledger). Pack submit and side-panel cards are follow-up seams;
  do not add WSS collect-result RPCs. Schema merge requires Frank approval.
- Sidebar expand state: `records-sidebar-expand.ts` owns sessionStorage recall
  for the last entry section (`activeSection`) and week openness; remount opens
  only that section (not every list that contains the selected report). Cold
  start without an entry prefers mine → members → favorites. Do not default
  every CollapsibleSection to open.
- Do not nest `ModalOverlay` under React Aria `Tabs`. Tabs' CollectionBuilder
  remounts children in a Hidden tree; ModalOverlay is not hideable, so an open
  dialog mounts twice and `ariaHideOutside` makes the visible one inert.
  Render settings dialogs as siblings outside `Tabs` (see `weekly-report-settings.tsx`).
- 「取消本周周报」and schedule-tick skip keys use the current ISO week
  (`currentIsoWeek(zonedCalendarDate(now))`), not the live format document's
  possibly stale `cycle`. Stamp dismiss with that calendar week.
- Format offer-send (发送 / 取消本周周报) is posted once per report for the
  current ISO week into the session that loads first. Earlier weeks' cards stay
  in that thread as history. Do not fan the current week's card out to every
  new or idle side-panel session (`hasCurrentWeekOfferSend`). Other sessions
  stay empty — do not stuff a ready/cancelled tip into them.
- Side-chat greetings (hi / 你好 / …) are not platform rule replies; route them
  through the weekly-report Agent like ordinary turns.
- Live format documents rebase onto the current ISO week when reused or when
  posting the offer-send card; do not keep showing the creation-week cycle after
  the calendar advances (see `rebaseLiveFormatToCurrentWeek`).
- Present mode shows one template-dimension page at a time and zooms images in
  place. It does not rewrite report JSON. Use a full-bleed portal
  (`report-present-mode.tsx`); `ModalOverlay` is padded and is not full-bleed.
- Reading a sent member report turns one wheel gesture at the body edge into
  the next template page, then the next submitted person of the same template.
  The author's editor does not. The chain stops at that template. Present mode
  stays on arrow keys within one report.
- After a member sends, further edits stay on the working body. Recipients
  (Leader report, dashboard summary, PPT) keep the last sent copy in
  `content.delivered` until the author sends again. Do not add a column for
  this snapshot.
- A weekly-report assistant body-edit writes the member report when that
  message is stored. `content.bodyRestore` keeps the previous body and that
  insert; the author switches between them, and edits stay on the side they
  leave. The assistant original stays in `content.assistantDraft`. Author and
  recipient views omit both snapshots. A card whose message was not written
  still shows Insert.
- `WeeklyReportAssistant.memory` stores one member's versioned writing habits,
  observations, threads, and one raw settlement per week. Submit, share, and a
  later send each wake settlement through `coforge weekly-report-memory submit`.
  The later send replaces that week's settlement. A preference that matches an
  existing habit is not stored again, and a retired habit stays retired until
  an explicit adopt. The next personal report injects active habits and
  remaining threads only. The settlement wake lists those habits so the
  assistant reuses their sentences. While that settlement runs, the side chat
  shows 「正在记录本周写作习惯，请稍候。」 and the same sentence on the progress
  bar; write-back changes it to 「已记录本周写作习惯。」 The model's own reply
  to that wake stays hidden.

- `server/records/weekly-report-workflow.server.ts` owns owner-scoped DM actions
  (discover, configure, send, save, submit, summarize); `weekly-report-distribution.server.ts`
  owns atomic per-settings/per-week distribution, and `weekly-report-notification.server.ts`
  posts invitations in the recipient's own assistant DM. Agent operations reuse
  the existing HTTPS weekly-reports endpoint; no generic job or mailbox is added.
- The Records tools menu has dashboard, stats and settings; the private assistant
  DM is the conversational entry point. Do not restore a duplicate assistant page.
- Agent template discovery does not require a cycle or submitted member reports.
  DM and page-scoped explicit requests use the same workflow operations. Do not
  intercept send or summarize phrases with side-panel keyword rules. A stored
  body-edit writes immediately; a card that was not written still shows Insert.
- Template discovery shares the workspace format catalog across DM/page context;
  only owner entries expose delivery settings and can be configured or sent.
  Other entries are reusable outlines, not grants to another owner's settings.
- `weekly-report-message-card.tsx` renders assistant collection plans and collected
  draft previews in chat using the existing Records configuration and write functions.
  Collector setup opens the profile in place and retains the plan until submission.
