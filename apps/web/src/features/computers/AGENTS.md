# Computers UI

These rules apply to `src/features/computers/`.

- `computer-layout.tsx` owns Computer list/detail selection, the return
  control, list scroll retention, and the empty state, following the same
  list/detail rules as Chat (`docs/design/task-first-layout.md` §2.1).
- Only runtimes marked in `RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN` get on-demand
  Usage scanning. The table reflects shipped adapters with a `readUsage` method,
  not whether they launch an external CLI. Pi, CoForge, Cursor, and OpenCode
  carry no status dot; for the Computer's owner every chip still opens its
  popover for the Public switch. A supported reader's account-specific
  `unsupported` result remains visible in its popover.
- A runtime's popover opens on a press, with a close button and Escape, as on
  Raft, on the Computer page and the Agent profile alike (`runtime-usage.tsx`).
  A quota reads as the share left.
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
- A runtime chip is its mark, its name and one round status dot (`runtime-chip.tsx`): green
  when signed in or its usage is fine, orange when signed out or its usage needs
  attention. Each state has one name wherever it shows (the dot's label is the
  popover badge's word): "Not signed in", "Error" over "Couldn't read usage.
  Refresh to try again." for any failed read, "Limit reached" over a quota row
  reading "Used up · resets …", "No usage reported" (Frank, 2026-10-26; the
  badges are Raft's). The account and plan sit in the popover and come only to the
  Computer's owner and Workspace owners and admins (`runtimeAuthView`), which the
  popover says; everyone else receives the state alone. A Computer that never
  reported shows no state.
- Sign in and Sign out sit in a Claude Code, Codex or Kiro runtime's popover for the
  Computer's owner and Workspace owners and admins, the server's own rule
  (`computer-runtimes.tsx`). The account is the popover's last band, as on Raft:
  the login state beside one button of the same weight signed in or out (Frank,
  2026-10-27, task #196). It and the Public switch stay in view while the bands
  above them scroll, so a phone never cuts an action off
  (`test/e2e-runtime-account-band.e2e.ts`). The dialogs subscribe to the viewer's
  `runtimeauth:user:<id>` channel and then read the login or logout once, and
  `runtime-auth-login-state.ts` drops whatever both deliver, so a view only
  moves a login forward. A device code, a pasted code and a sign-in link live
  only in the dialog's state: never in a log, a toast or a URL. Only an `https:`
  sign-in page is opened, with `noopener,noreferrer`. The browser E2E plays the
  daemon (`test/e2e-runtime-sign-in.e2e.ts`); no test signs a real runtime in or
  out.

- Kiro enterprise sign-in collects the IAM Identity Center Start URL and AWS Region once, then uses the shared progress dialog. Only Computers advertising `runtime-auth:kiro-idc:v1` accept it. These inputs are not saved as account settings.
