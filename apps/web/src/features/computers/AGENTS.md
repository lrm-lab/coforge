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
