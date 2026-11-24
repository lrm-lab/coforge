# Computers UI

These rules apply to `src/features/computers/`.

## Module map

- One Computer's detail panel is `computer-detail*.tsx` with `use-computer-detail-lifecycle.ts` (upgrade slots, restart polling); `computer-layout.tsx`, `computer-overview-toolbar.tsx`, `computer-card.tsx`, `computer-table.tsx`, `computer-batch-upgrade-dialog.tsx`, `computer-overview-model.ts`, and `computer-overview-layout.ts` own the full-width Computers overview (Card / List view persisted via device preference, search/filter/group/sort, cached runtime quota meters, batch & per-card runtime upgrades) and the desktop resizable split detail pane (`md+`, with expand/collapse and close controls in `computer-detail-header.tsx`).
- `runtime-reset-credit-action.tsx` and `runtime-reset-credit-state.ts` — the runtime popover's Raft-aligned reset credit prompt (`resetCreditPrompt`, `canOfferAgentResetCredit`), action/callout (`RuntimeResetCreditAction`), and confirm dialog (`RuntimeResetCreditDialog`, mounted outside the popover by `RuntimeUsage`)
- `reset-credit-attempt.ts` — the reset attempt's idempotency key per Computer + provider + account label (`sessionStorage`, memory fallback); expires 10 minutes after it was made, cleared only on a settled outcome, kept after `unknown`, a refusal or a thrown failure. The dialog treats `already_redeemed` like `reset` (toast, close); any other settled answer shows its message and turns Confirm off (`ConfirmDialog`'s `confirmDisabled`)
- `poll-for-answer.ts` — the shared wait for a started request: asks until the answer is not pending, asks again after a read that failed, and ends as the caller's give-up value at the deadline or when the caller's signal aborts (unmount). The reset credit (`reset-credit-poll.ts`), the Agent form's Command Code efforts (`features/agents/use-command-code-efforts.ts`, with `command-code-effort.functions.ts`: from 250 ms, doubling to 1.5 s, 45 s deadline, ends with no efforts), the Agent panel's Stop current turn (`features/agents/agent-turn-interrupt-poll.ts`), the runtime catalog refresh (below), the Agent context view (`features/agents/agent-context-view-poll.ts`, with `agent-context-view.functions.ts`: from 250 ms, doubling to 1 s, 30 s deadline, ends as `timeout`; no UI calls it yet) and every Pi chat command (`features/pi-chat/pi-chat-poll.ts`, run by `use-execute-pi-chat.ts`: from 50 ms, doubling to 500 ms, 25 s deadline inside the reply's 30 s lifetime, ends as the unavailable error) all poll through it; a Server Function that waits on a Computer longer than about eight seconds must be split into start and read the same way
- `runtime-catalog-refresh.functions.ts`, `runtime-catalog-refresh-poll.ts` and `use-runtime-catalog-refresh-request.ts` — the Agent form's refresh and the Computer page's Rescan runtimes: `startRuntimeCatalogRefresh` returns at once, `readRuntimeCatalogRefresh` returns pending or the outcome, and `awaitRuntimeCatalogRefresh` polls (from 500 ms, doubling to 1.5 s, 50 s deadline: longer than the Daemon's 45 s probe budget, inside the 60 s pending request) and resolves to a named refresh outcome, a whole-Computer report, a request-level error, or timeout. The whole-Computer report names every visible success and failure; its sign-in feedback uses the visible runtime login state from the Computer detail. The hook ends the wait only when the asking component unmounts
- `use-reset-credit-consume.ts` — the dialog's `onConsume`: starts with `consumeResetCredit`, then polls `readResetCredit` (`reset-credit-poll.ts`: every 1.5 s, read failures asked again, 100 s deadline or unmount ends as `unknown` so the key is kept); resolves to the refusal (`forbidden`, `offline`, `needs_upgrade`) as a value, which the dialog shows without touching the attempt's key (a thrown failure keeps it too), and re-reads the popover's usage after a settled answer, scanning it as Refresh does when the cache holds no reading from that attempt (`usageCarriesAttempt`); when triggered with an `agentUsage` scope, also refreshes the Agent's usage cache and invalidates `agent-runtime-usage` for the Computer

- `computer-layout.tsx` owns the Computers overview (`/computers`, no desktop auto-redirect),
  resizable split detail pane on `md+` (expand/collapse + close back to `/computers`), phone
  list/detail navigation, cached `runtimeUsages` meters (batch-read via Redis `MGET` in
  `computer-list-usage.server.ts`, zero daemon RPCs on overview load), and per-Computer / batch
  upgrade triggers feeding into `ComputerUpgradeWatcher`, following `docs/design/task-first-layout.md` §2.1.
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
- Reset credits (Codex only) live inside the shared `RuntimeUsage` component so the Computer page
  and the Agent profile behave identically, following Raft: when `resetCreditsAvailable` is
  reported and the reset button is not shown, a facts line below the usage meters names the
  remaining resets (joined with credits balance when present; when the button is shown, the count
  appears only on the button). The reset button appears only when `canResetCredit` is true, signed
  in, and a credit is available — hidden below 80% usage, secondary at ≥80% used, and a warning
  callout with a primary button when rate-limited or at `limit_reached` (`resetCreditPrompt`). On
  the Agent profile, `canResetCredit` is enabled only when the Agent has no per-Agent credential
  override (`canOfferAgentResetCredit`), matching the Computer-scoped reset endpoint. Neither the
  page nor the profile offers usage for a runtime that cannot start (`unavailableCode`). Anyone
  but the Computer's owner reads only the fields the popover draws, never the credit balance. The
  confirm dialog renders outside `<Popover>` inside `RuntimeUsage`, keyed by `(computerId,
provider)`, with its count and account label fixed when it opens.
- A cloud Computer belongs to the account: one default, started when first
  sign-in creates the personal Workspace and again when another Workspace is
  created, and ensured once more when the Computers page opens. That start also
  binds the creator's weekly-report assistant to the default computer. Each
  Workspace can add one extra. The cluster places it. The page does not ask the
  user to pick a host. Another member's default cloud Computer stays linked for
  that owner's Agents and daemons, but `listComputers` / `listComputerNames`
  hide it from everyone except its owner (`computer-list-visibility.server.ts`);
  extras and local Computers stay listed for every member. The owner's Computer detail Open
  desktop opens `/desktop/<computer id>/` when `COFORGE_CLOUD_DESKTOP_ORIGIN` is set: below
  `sm` as an in-page overlay (`cloud-desktop-overlay.tsx`), wider as a named popup that
  opening again brings forward. The Agent profile Computer row embeds
  `/desktop/<computer id>/<agent id>/` in-page (thumbnail → overlay; see
  `agent-desktop-thumbnail.tsx`). On a phone portrait viewport the maximized chrome offers
  Landscape view (CSS fake-landscape via `desktop-landscape.ts`); Portrait view, minimize,
  or sleep clears it. In landscape the title chrome overlays and auto-hides after idle
  (`desktop-chrome-autohide.ts`); a top-edge handle reveals it. Portrait phone and wider
  viewports keep the chrome always visible. A phone iframe adds `view=phone`
  (`withCloudDesktopPhoneView`) so the shared 1080p desktop keeps computer-primary geometry
  while the noVNC page offers fit vs native-size pan, a Keyboard control that opens the
  system soft keyboard, Esc/Ctrl/Tab/arrows, long-press right-click, two-finger scroll and
  pinch to toggle fit/pan; the cloud image dock stays visible with larger touch targets.
  Action-card takeover follows the same phone overlay / wide popup
  split. Focused plain-text paste on that desktop page posts UTF-8 to `/clipboard` then
  injects Ctrl+V (`packages/computer` `host/desktop-page.ts`); classic Latin-1
  ClientCutText is not used. Copy inside the desktop is read back via GET
  `/clipboard` into the local clipboard. Files and images are not. That origin is the deployment site; Caddy confirms the signed-in owner
  before proxying to the Swarm host. The address carries no token. Without the variable the
  control is absent. Formatting a cloud computer removes its service and disk,
  then places the same computer again. The owner must type its name; the server
  checks that name. Agents, messages, and workspace links stay.
- An upgrade's status is polled and settled only by `ComputerUpgradeWatcher`, mounted in the
  Workspace shell so it survives leaving the Computers page. The detail observes the same query
  without polling, and the list reads loader data (`computer-upgrade-status.ts`). A read that
  fails and then idles stops the follow; opening Computers starts it again. That recovery fetch
  still reports the old error while `isFetching` is true, and the follow stays until it returns.
- Every member is told an update is waiting on the list tile's badge, while the owner's detail
  panel keeps a clean user-first hierarchy without a full-width upgrade card: the 48px top bar
  (`computer-detail-header.tsx`) carries the Computer icon with corner presence dot, inline-editable
  title (`computer-detail-title.tsx`), more menu (`···` for Format / Remove / Delete), and split
  Expand/Close controls; the Hero (`computer-detail-hero.tsx`) shows single-line metadata, offline
  guidance when disconnected, primary actions (Open desktop, in-place Upgrade / Upgrading / Retry,
  Restart), and frameless vertical Disk & Memory rows; next come the Agents roster, Available AI
  tools + compact 2-column specs (`computer-detail-stats.tsx`), and a single collapsible
  `computer-detail-advanced.tsx` band (workspace cleanup + terminal troubleshooting — collapsed by
  default when online and healthy, auto-opened when offline or on an upgrade issue). `ComputerUpgradeWatcher` drives one aggregated cross-route `toast.progress`
  capsule across concurrent runtime upgrades (naming the Computer for one, or the count for many)
  that morphs to done on success (resuming remaining active upgrades after the done window) or
  surfaces per-Computer `appNotice` cards on failure (§13). `useComputerDetailLifecycle` also reads
  `followedComputerUpgradesQuery` so switching between Computers preserves in-flight upgrade state.
  A local Computer owner also sees pending `InstallerRecoveryAdvice` under Version when an
  upgrade or retry is offered. A newer cloud node image stays on its own Image row and bordered
  `ComputerUpgradeSlot`. Versions always show in full (`0.1.4-dev.2`, never `dev.2`).
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
