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
  user to pick a host. The owner's Open desktop button opens
  `<COFORGE_CLOUD_DESKTOP_ORIGIN>/desktop/<computer id>/` in its own window when that
  deployment variable is set, and opening it again brings that window forward.
  The same owner's Computer tab opens that Agent's
  own screen at `/desktop/<computer id>/<agent id>/`, in that Agent's window.
  That origin is the Swarm
  host proxy in front of the image, opened directly by the browser. The address
  carries no token. Without the variable the button is absent. Formatting a cloud computer removes its service and disk,
  then places the same computer again. The owner must type its name; the server
  checks that name. Agents, messages, and workspace links stay.
- An upgrade's status is polled and settled only by `ComputerUpgradeWatcher`, mounted in the
  Workspace shell so it survives leaving the Computers page. The detail observes the same query
  without polling, and the list reads loader data (`computer-upgrade-status.ts`). A read that
  fails and then idles stops the follow; opening Computers starts it again. That recovery fetch
  still reports the old error while `isFetching` is true, and the follow stays until it returns.
- Every member is told an update is waiting: the list tile's badge and the detail's upgrade slot,
  which for a member who is not the owner is a plain "v{X} available" line, never a request to ask
  the owner. The Version row is the runtime the daemon reported. A local Computer offers a newer
  release there. A cloud Computer does not: its runtime stays the image it was started from, and a
  newer node image is a separate Image row. That row names the image the computer is running (the
  node image's label when the layers match) and offers a replace when they differ. A running or
  failed upgrade shows to every member; Upgrade and Retry stay the owner's.
  Versions always show in full (`0.1.4-dev.2`, never `dev.2`). A success has no inline slot: the
  row that owned the upgrade changes, and the watcher's toast confirms it (§13).
- The slot's "What's new" opens the notes the release catalog (`server/release-catalog/`) holds for
  the release on offer or being installed, in the UI's language with the other as fallback. No
  notes, or a failed read, means no link and never an error; it never holds up Upgrade.
- A login-capable runtime's chip carries its last reported login state
  (`runtime-chip.tsx`). The account and plan come only to the Computer's owner
  and Workspace owners and admins (`runtimeAuthView`); everyone else receives
  the state alone. A Computer that never reported shows no state.
