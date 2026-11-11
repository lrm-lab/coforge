# Tasks board rows, cards and hidden columns

- Rows and cards follow Linear: a status is `TaskStatusIcon` (a ring that
  fills as work advances, colours from `TASK_STATUS_COLOR`); list rows are one
  line (number, status, title, source and Project pills, owner avatar); cards
  put number and source over the title with the owner avatar beside them.
  A task reference in a message body is `TaskNumberBadge`: `#N` on the
  status's Untitled UI colour badge with the same ring leading.
- Board columns can be hidden from their "···" menu, as Linear allows; hidden
  ones are listed last (`HiddenColumn`), stay drop targets, and show again when
  pressed. Every column shows by default; the choice is per device
  (`features/settings/task-hidden-columns.ts`, on the shared
  `device-preference.ts` store) and a boot-script class, so a hidden column
  never flashes while hydrating and never reads its pages.
