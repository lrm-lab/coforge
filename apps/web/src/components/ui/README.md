# `src/components/ui/` — deviations from official components

Everything else in the app uses Untitled UI's official components unmodified
(`src/components/base/`, `src/components/application/`, installed via
`npx untitledui@latest add <name>`). The files in this directory are the only
hand-written UI primitives, kept here because Untitled has no equivalent for
them. Each one composes React Aria and/or official Untitled components at the
call site — none of them fork or copy an official component's source. See
`docs/design/official-components.md` §7.

| File                        | Why it exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date-calendar.tsx`         | Task creation and editing share a React Aria month grid with keyboard navigation and a viewer-time-zone today marker.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `relative-time.tsx`         | CoForge-specific "6h ago" formatting + live re-render, built on the official `Tooltip`/`TooltipTrigger` (`#src/components/base/tooltip/tooltip`) for the exact-timestamp tooltip. Also exports `ClockTime`, the same hydration-safe/tooltip wiring showing a fixed `HH:MM:SS` instead, used by the Activity timeline's clock column.                                                                                                                                                                                                        |
| `input-otp.tsx`             | Thin wrapper around the `input-otp` library (which Untitled doesn't wrap), restyled with Untitled tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `status-dot.tsx`            | The one live-status dot for Agents and Computers (Activity log rows use their own outlined marker). Untitled's `AvatarOnlineIndicator` only knows online/offline and is glued to `Avatar`; CoForge also needs working/thinking/error tones with a pulse, on tiles and inline status lines. Used by `features/agents/**` and `features/computers/computer-tile.tsx`.                                                                                                                                                                         |
| `unread-marker.tsx`         | The one unread count badge, unified unread capsule (`count \| 💬 threadCount`) and unread dot. Untitled's `Badge` is a labelled pill, not a count, split capsule or bare marker; the sidebar, conversation rows, Activity list, thread summary and records list all use these primitives.                                                                                                                                                                                                                                                   |
| `rolling-number.tsx`        | Untitled UI has no animated number. A non-negative integer whose digits roll like an odometer when it changes (a carry rolls forward, never back down), built on `motion` springs. It stays plain text until the number first changes and under reduced motion. Used by `unread-marker.tsx`'s `UnreadBadge` and `features/conversations/message-reaction-badges.tsx`.                                                                                                                                                                       |
| `reorderable-tab-strip.tsx` | Untitled UI has no reorderable tab strip and React Aria drag-and-drop only reorders collection components (ListBox/GridList). Renders the official horizontal `underline` `Tabs` list and drags its tabs with dnd-kit and `drag-ripple/`; capture-phase listeners start the drag because the tab stops its press events from bubbling, and each tab selects from its own `onPress` so a drag never switches views. Used by `features/tasks/conversation-task-tabs.tsx` and `features/agents/profile-panel/agent-profile-tabs.tsx`.          |
| `drag-ripple/`              | Neither Untitled UI nor dnd-kit draws an insertion line. The drag-to-reorder motion every reorderable list shares, over dnd-kit: the picked item lifts off the list and its slot closes, a faint line marks the gap it will take while the items either side lean away by distance, and on release everything springs into place (`motion`'s `spring` as CSS easing). Transforms only; reduced motion keeps the line alone. Used by the tab strip, the sidebar directory and report page tabs; the Task board uses its lift and landing.    |
| `progress-steps.tsx`        | Untitled UI React's Progress steps are PRO-only (`npx untitledui@latest add progress-steps` asks for PRO access). A vertical `<ol>` of steps marked complete (check), current (a still dot, `aria-current="step"`; nothing animates) or incomplete (empty ring), composed from `@untitledui/icons` with semantic tokens. Used by `features/computers/computer-upgrade-slot.tsx`; an approved exception to the "more than one place" rule below, since the official component is PRO-only and other multi-step flows are expected to use it. |
| `fold.tsx`                  | Untitled UI has no collapse transition. Content that folds shut (height to zero as it fades) and opens again, interruptibly, timed by the `motion-enter` / `motion-leave` tokens, so what is below moves rather than jumps. Used by the notification list (a dismissed notice) and the choice and questions action cards (Ignore, Undo).                                                                                                                                                                                                    |

Dialogs are listed in [`dialogs.md`](dialogs.md), popovers and notices in [`overlays.md`](overlays.md), and loading and empty states in [`states.md`](states.md), under the same rules.

Nothing outside this list should exist as a non-official component. If a page
needs something Untitled doesn't provide, compose it inline at the call site
from React Aria / official pieces first; only promote it to a new file here
if it's reused in more than one place, and add a row to this table explaining
why the official library has no equivalent.

The one sanctioned copy-and-adapt exception, the app sidebar, is described in
[`layout/sidebar/README.md`](../layout/sidebar/README.md).

One approved edit to an official file: `base/tooltip/tooltip.tsx` opens its first tooltip after
500ms instead of Untitled's 300ms (Frank, 2026-11-03), so a pointer passing over a row of icon
buttons does not pop one up. It is the component's default, so `ButtonUtility`'s tooltips follow;
once one is open, a neighbour still opens at once (React Aria's warm-up). Keep it when updating the
file from upstream.

## Lint config

## Lint config

`.oxlintrc.json` / `scripts/oxlint-plugin.js` may only be changed to exempt an
**unmodified official file** under `src/components/base/**` or
`src/components/application/**` from a `coforge/no-native-*` rule (each
override names the specific file, with the reason in the commit message).
Product code — this directory, `src/features/**`, `src/components/layout/**`,
routes, tests — is never exempted; a lint hit there means fix the code (see
`relative-time.tsx`'s `aria-label` fallback for an example), not loosen the
rule. No `oxlint-disable`, `@ts-ignore`, or `@ts-expect-error` comments
anywhere in the codebase.
