# Computers UI

These rules apply to `src/features/computers/`.

## Module map

- The handoff wizard (`local-session-handoff-dialog.tsx`, `handoff-session-picker.tsx`, `handoff-form.tsx`, `handoff-states.tsx`, `use-handoff-create.ts`, `use-local-session-handoff.ts`, `local-session-state.ts`, `local-session-list.ts`, `handoff-briefing.ts`): the dialog owns the session search, so "换一个会话" returns to the same list; creating the Agent, opening its DM and sending the briefing share one idempotency key and a resend never recreates; an unfinished empty list is busy, never empty, and sessions come out newest first; `use-local-session-handoff.ts` is the one place to swap in fixture data.
- One Computer's detail panel is `computer-detail*.tsx` with `use-computer-detail-lifecycle.ts` (upgrade slots, restart polling); `computer-layout.tsx` holds list/detail selection.
- `runtime-reset-credit-action.tsx` — the runtime popover's "Use reset · N" button and its confirm dialog (outside the popover, like the sign-out dialog); takes the count and an `onConsume(idempotencyKey)` as props
- `reset-credit-attempt.ts` — the reset attempt's idempotency key per Computer + provider + account label (`sessionStorage`, memory fallback); expires 10 minutes after it was made, cleared only on a settled outcome, kept after `unknown`, a refusal or a thrown failure. The dialog treats `already_redeemed` like `reset` (toast, close); any other settled answer shows its message and turns Confirm off (`ConfirmDialog`'s `confirmDisabled`)
- `poll-for-answer.ts` — the shared wait for a started request: asks until the answer is not pending, asks again after a read that failed, and ends as the caller's give-up value at the deadline or when the caller's signal aborts (unmount). The reset credit (`reset-credit-poll.ts`), the Agent form's Command Code efforts (`features/agents/use-command-code-efforts.ts`, with `command-code-effort.functions.ts`: from 250 ms, doubling to 1.5 s, 45 s deadline, ends with no efforts), the Agent panel's Stop current turn (`features/agents/agent-turn-interrupt-poll.ts`), the runtime catalog refresh (below), the Agent context view (`features/agents/agent-context-view-poll.ts`, with `agent-context-view.functions.ts`: from 250 ms, doubling to 1 s, 30 s deadline, ends as `timeout`; no UI calls it yet), every Pi chat command (`features/pi-chat/pi-chat-poll.ts`, run by `use-execute-pi-chat.ts`: from 50 ms, doubling to 500 ms, 25 s deadline inside the reply's 30 s lifetime, ends as the unavailable error) and the file upload panel (`computer-file-upload-poll.ts`: from 250 ms, doubling to 1.5 s, a 930 s deadline past the server's store and pull limits, ends as a `timeout` failure) all poll through it; a Server Function that waits on a Computer longer than about eight seconds must be split into start and read the same way
- `runtime-catalog-refresh.functions.ts`, `runtime-catalog-refresh-poll.ts` and `use-runtime-catalog-refresh-request.ts` — the Agent form's refresh and the Computer page's Rescan runtimes: `startRuntimeCatalogRefresh` returns at once, `readRuntimeCatalogRefresh` returns pending or the outcome, and `awaitRuntimeCatalogRefresh` polls (from 500 ms, doubling to 1.5 s, 50 s deadline: longer than the Daemon's 45 s probe budget, inside the 60 s pending request) and resolves to refreshed, error with the runtime's reason, or timeout; the hook ends the wait only when the asking component unmounts
- `computer-file-upload-panel.tsx` — the owner's file upload: an XHR posts the file and the server answers with an upload id once it has the body; the panel then polls `readComputerFileUpload` (`computer-file-upload.functions.ts`) while it shows its uploading state (`server/computers/AGENTS.md`)
- `use-reset-credit-consume.ts` — the dialog's `onConsume`: starts with `consumeResetCredit`, then polls `readResetCredit` (`reset-credit-poll.ts`: every 1.5 s, read failures asked again, 100 s deadline or unmount ends as `unknown` so the key is kept); resolves to the refusal (`forbidden`, `offline`, `needs_upgrade`) as a value, which the dialog shows without touching the attempt's key (a thrown failure keeps it too), and re-reads the popover's usage after a settled answer, scanning it as Refresh does when the cache holds no reading from that attempt (`usageCarriesAttempt`); Refresh joins a scan already running, and the server ends any scan that began before the spend, so this scan is always a later one

- `computer-layout.tsx` owns Computer list/detail selection, the return
  control, list scroll retention, and the empty state, following the same
  list/detail rules as Chat (`docs/design/task-first-layout.md` §2.1).
- Only runtimes marked in `RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN` get on-demand
  Usage scanning. The table reflects shipped adapters with a `readUsage` method,
  not whether they launch an external CLI. Pi, CoForge, Cursor, and OpenCode
  carry no status dot; for the Computer's owner every chip still opens its
  popover for the Public switch. A supported reader's account-specific
  `unsupported` result remains visible in its popover. Refresh waits for the daemon to re-read
  and report native login status as well as usage, then invalidates route data so the new
  Computer authentication snapshot reaches its popover; Agent Profile shares the usage refresh.
  A sign-in or sign-out shows without a reload: the daemon reports the new login status, the
  server announces each stored report on every viewer's `runtimeAuthChannel`, and the Computer
  page re-reads its routes (`useRuntimeAuthStatusRefresh`); a runtime that becomes signed in
  scans its usage once. The dialogs do not invalidate: their result arrives before that report.
- A runtime's popover opens on a press, with a close button and Escape, on the Computer page and the Agent profile alike (`runtime-usage.tsx`).
  A quota reads as the share left.
- The reset credit button (Codex only) sits immediately left of Sign Out in the `accountAction`
  cluster of `computer-runtimes.tsx`. `RuntimeUsage` hands `accountAction` the usage snapshot it
  read, so the count (`resetCreditsAvailable`) and the account label come from the popover's own
  reading. That reading, the usage popover (`showUsage` is `canSignIn`; on the Agent profile
  `runtimeUsageVisible`, which the server decides through `RuntimeUsageAccess`) and the button all
  follow the server's `canManage`: the Computer's owner and Workspace owners and admins
  (`server/computers/AGENTS.md`) over a runtime they see on the page (another member's only once
  public); a plain member sees none of them. Neither the page nor the profile offers usage for a
  runtime that cannot start (`unavailableCode`). Anyone but the Computer's
  owner reads only the fields the popover draws, never the credit balance. The dialog is a third
  `AuthDialog` kind, rendered outside the popover with parent-held state; the count and label it
  names are fixed when it opens.
- A cloud Computer belongs to the account: one default, started when first
  sign-in creates the personal Workspace and again when another Workspace is
  created, and ensured once more when the Computers page opens. That start also
  binds the creator's weekly-report assistant to the default computer. Each
  Workspace can add one extra. The cluster places it. The page does not ask the
  user to pick a host. Another member's default cloud Computer stays linked for
  that owner's Agents and daemons, but `listComputers` / `listComputerNames`
  hide it from everyone except its owner (`computer-list-visibility.server.ts`);
  extras and local Computers stay listed for every member. The owner's Open desktop button opens
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
  the owner. The Version row is the runtime the daemon reported. A local Computer and a cloud
  Computer both offer a newer release there: the cloud copy is installed onto the computer's
  volume and the container restarts on the same image. A newer node image is a separate Image
  row. That row names the image the computer is running (the node image's label when the layers
  match) and offers a replace when they differ. A running or failed upgrade paints only its own
  row (Version for runtime, Image for a node-image replace), including after a reload, from the
  status `target`; Upgrade and Retry stay the owner's.
  Versions always show in full (`0.1.4-dev.2`, never `dev.2`). A success has no inline slot: the
  row that owned the upgrade changes, and the watcher's toast confirms it (§13).
- The slot's "What's new" opens the notes the release catalog (`server/release-catalog/`) holds for
  the release on offer or being installed, in the UI's language with the other as fallback. No
  notes, or a failed read, means no link and never an error; it never holds up Upgrade.
- A runtime chip is its mark, its name and one round status dot (`runtime-chip.tsx`). The dot
  and the popover badge read one table (`runtime-usage-status.ts`): green for signed
  in or usage OK (an old read too: the popover shows its age); orange for "Not signed in",
  "Update Computer to sign in or out here" and "Limit reached". Red is kept for a state retrying
  cannot fix; none is. A failed usage read says nothing (Frank): no dot, no badge, no usage block,
  so the dot follows the login state. A reader not connected, or a runtime that reports no usage,
  has no dot and no badge, one gray line. The account and plan sit in the popover and come only
  to the Computer's owner and Workspace owners and admins (`runtimeAuthView`), which the popover
  says; everyone else receives the state alone. With no plan and no account the account row has
  no heading.
- Every login state has an outcome in the popover, never a blank, and the popover
  never says a state could not be read (Frank): a failed login check (`unknown`) reads
  as signed in while usage still reads (reading usage needs a signed-in account), else as signed
  out (`shownAccount`). Signed out and unreported (a Computer too old to send one, said only to
  those who may sign in) take the orange band, the only states the user must act on. Sign In and
  Sign Out are icons the size of Refresh, named by tooltip and label, for the state shown.
  Refresh rereads both login and usage.
- Sign in and Sign out sit in a Claude Code, Codex or Kiro runtime's popover for the
  Computer's owner and Workspace owners and admins, the server's own rule
  (`computer-runtimes.tsx`). The account is the popover's last band:
  the login state beside one button of the same weight signed in or out (Frank,
  2026-10-27). It and the Public switch stay in view while the bands
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
