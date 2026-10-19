# Computers UI

These rules apply to `src/features/computers/`.

- `computer-layout.tsx` owns Computer list/detail selection, the return
  control, list scroll retention, and the empty state, following the same
  list/detail rules as Chat (`docs/design/task-first-layout.md` §2.1).
- Only runtimes marked in `RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN` get on-demand
  Usage scanning. The table reflects shipped adapters with a `readUsage` method,
  not whether they launch an external CLI. Pi, CoForge, Cursor, and OpenCode
  render as plain, non-focusable identities without usage health dots; a
  Computer runtime's Public switch still opens its footer controls. A supported
  reader's account-specific `unsupported` result remains visible in its popover.
- A cloud Computer belongs to the account: one default, started when first
  sign-in creates the personal Workspace and again when another Workspace is
  created, and ensured once more when the Computers page opens. That start also
  binds the creator's weekly-report assistant to the default computer. Each
  Workspace can add one extra. The cluster places it. The page does not ask the
  user to pick a host. Formatting a cloud computer removes its service and disk,
  then places the same computer again. The owner must type its name; the server
  checks that name. Agents, messages, and workspace links stay.
- An upgrade's status is polled and settled only by `ComputerUpgradeWatcher`, mounted in the
  Workspace shell so it survives leaving the Computers page. The detail observes the same query
  without polling, and the list reads loader data (`computer-upgrade-status.ts`).
