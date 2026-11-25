# Tasks board rows, cards and hidden columns

- Rows and cards follow Linear: a status is `TaskStatusIcon` (a ring that
  fills as work advances, colours from `TASK_STATUS_COLOR`); list rows are one
  line (number, status, title, source and Project pills, owner avatar); cards
  put number and source over the title with the owner avatar beside them.
  A task's due day is a small calendar mark at a card's foot and a list row's
  end, in the error colour once overdue and the warning colour within a day
  (task #13).
  A task reference in a message body is `TaskNumberBadge`: `#N` on the
  status's Untitled UI colour badge with the same ring leading.
- Board columns can be hidden from their "···" menu, as Linear allows; hidden
  ones are listed last (`HiddenColumn`), stay drop targets, and show again when
  pressed. Every column shows by default; the choice is per device
  (`features/settings/task-hidden-columns.ts`, on the shared
  `device-preference.ts` store) and a boot-script class, so a hidden column
  never flashes while hydrating and never reads its pages.
- Opening a Task on desktop (`>= lg`) keeps the board or list visible beside a
  resizable right-hand split pane (`TaskDetailPanel`) with `↑/↓` prev/next task
  navigation, `⤢` expand to full 2-column view (with the `w-72` property
  sidebar), and `×` close. The opened card or row carries `data-selected`
  highlight styling and calls `scrollIntoView({ block: "nearest", inline: "nearest" })`
  so Kanban cards stay in view when the split opens. Narrow viewports (`< 64rem`)
  open the Task in the two-detent bottom sheet (`TaskDetentSheet`, 64% ↔ 94%).
