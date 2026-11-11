# Weekly report behaviour specs

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
