# Mascots and the busy-Agents line

Part of [Agents UI](AGENTS.md). Rules for `src/features/agents/`.

- A mascot moves only where `AgentMascotView` draws it, and only on these surfaces: the
  busy-Agents line above a main composer, the chat list header's busy Agents (below), the
  Direct-message list rows (`DirectAgentAvatar` in
  `features/conversations/`, through `AgentMascotAvatar`; the row's pointer state reaches it as
  `hovered` through `useRowHovered`, so a hover repaints only the mascot), the Agent hover card, the
  Agent profile card (not its header, which repeats it) and the mascot picker
  (`agent-avatar-dialog.tsx`: all seven idle, the one under the pointer reacting, the selected one
  still moving). The message stream, in channels and Direct messages alike, is static: its avatars
  are the still sticker (`LiveAgentAvatar`, `IdentityAvatar`). A mascot carries the Agent's mascot
  key (`LiveAgent.mascot`, the profile's `mascot`), never a URL to reverse. The Rive canvas mounts
  only while it is near the viewport, motion is allowed and the shared file loads
  (`mascot-rive.tsx`, the only `@rive-app/*` importer); anything else stays the still picture. A
  moving mascot's eyes follow the cursor (below). Names: `mascot-contract.ts` and
  `mascot-rive-contract.ts`, shared with the generator (`assets/mascots/README.md`).
- Every Agent mascot and every cartoon person is a sticker (Frank's references, 2026-10-23, for
  mascots and people): `AvatarSticker` (`features/avatars/avatar-sticker.tsx`) is the one markup
  for it, the bare white-edged figure with no circle or fill behind it (Frank, 2026-10-23) at every
  size, drawn at 110% of the avatar's box, unclipped, so it passes the box by only a few percent
  (`.avatar-sticker`, `.avatar-sticker-figure` in `styles.css`), with the status dot slot (a quarter
  of the avatar, at its bottom-right with the page-coloured ring). A picture that cannot load
  leaves the initial on a small round tile. The figure keeps one size and place in every activity: a
  change only reshapes the face, poses an accessory, mutes the colours or shows the thinking
  bubble, which stays inside the box. The moving avatar (`AgentMascotAvatar`), the still one
  (`AgentDisplayAvatar`, `AgentStackFace`), a channel's lone member and the busy-Agents line all
  draw through it. A picture is a sticker when `isStickerPicture` (`features/avatars/sticker-picture.ts`) says so: an Agent's mascot
  (`isMascotPicture`) or a cartoon person (`isPersonPicture`, `src/lib/person-picture.ts`: four WebP
  stickers (256 px, transparent) `public/avatars/person-<n>-<version>.webp`, the profile avatar
  presets in `features/profiles/avatar-presets.ts`; a person with no avatar gets the one their id
  hashes to, `personAvatarUrl`, which the server applies so no read returns a null avatar). Anywhere
  a picture may be a person's or an Agent's, features use `IdentityAvatar`, which sends a sticker
  picture to the sticker and anything else, a person's uploaded photo, to the base `Avatar` (`name`
  gives the initial and its tone; `deleted` greys either). Only a face whose picture can be missing
  locally (the settings preview after removing the avatar) passes `userId`, for the default cartoon.
  The base `Avatar` and the other base components know nothing of stickers, so a person's face is
  never drawn through them directly, and a feature draws an Agent's face itself (the task assignee
  menu passes `assigneeFace` as the item icon). A channel's group avatar puts its members' stickers
  overlapping with no fill behind them (`group-avatar.tsx`, `collage-layout.ts`): a person with an uploaded photo
  there is that round photo with a white edge. Stacked faces carry the stack's page-coloured
  separator ring. The pickers (`AvatarChoice`) draw each figure as a sticker on a tile whose
  selection is a neutral ring and light fill; the person presets stay still, the mascots move.
- `busy-agents-strip.tsx` is the line above a main composer naming the conversation's Agent
  members that are working or thinking, wherever they are busy: `busy-agents-summary.ts` (pure)
  filters and groups them by `agentDisplay` label (`activitySentenceLabel` words it for the
  sentence) and joins the names with `Intl.ListFormat`, the strip reads `useLiveAgents()`, and the
  conversation hands it only the member ids through `ConversationProps.aboveComposer` (the main
  pane only). One 24px mascot sticker (`AgentMascotView` in an `AvatarSticker`) cycles every 4s with a crossfade, the leaving
  one a still picture (`busy-agents-strip.css`); reduced motion stops the cycle and the fade. The
  sentence is plain text, not a live region; only the overflow count (`agent_busy_others`) is a
  message, the labels are not localized.
- The chat list header (`busy-agents-stage.tsx`, after the "Chat" heading) shows the Workspace's
  Agents that are working or thinking, every one the viewer may see and not only their own
  (`busy-agents.ts`, `use-workspace-busy-agents.ts`: Agents with a Direct message first, then
  the viewer's own, then the others, each group by name) as 24px moving stickers, with no names or
  words: as many as fit, one per 34px, three to five (`stageCapacity`). The rest wait behind a
  count in the thread following-Agents trigger's style, which opens all of them in that popover's
  style (`agent-list-popover.tsx`, shared with it), each row with its current label. Who may be
  seen is the Members directory's rule (`listExtraAgents`, `visibleAgentWhere`); the Agents are the
  provider's extras, kept live by the status publications `useAgentStatuses` already holds
  ([AGENTS.md](AGENTS.md), "Agent state in the browser"). `busy-agents-cast.ts` (pure) decides who
  is on stage: they rotate (14–40s on, one at a time, a newly busy Agent first, then the one shown
  least recently), an Agent that stops goes back and stays off, one the viewer points at or reads
  the card of stays. `busy-agents-motion.ts` (pure) moves them: a slide with a small hop, no legs
  or walk cycle, in and out from behind the count's edge, which masks them; they may pass each
  other. `busy-agents-stage-loop.ts` runs both in one animation-frame loop that writes their
  transforms (only when one changed) and only while the stage is on screen, so React renders only
  when the cast changes. Each is the Agent's avatar as in a message stream: it peeks at the Agent
  card and opens the profile on a press (any visible Agent's profile opens, not only the viewer's
  own). Reduced motion leaves still faces and the count, with no rotation and no loop.
- A moving mascot's eyes follow the cursor. `mascot-look.ts` (pure) maps the pointer's offset from
  the canvas centre to `lookX` / `lookY` in [-1, 1] (full deflection at 350 px, flattening toward
  it), and `mascot-look-tracker.ts` is the one passive document `pointermove` listener every
  moving canvas shares: at most one pass per animation frame, writing the numbers straight into
  each instance's view model (never React state). The eyes ease back when the pointer leaves the
  window or the window blurs; touch pointers and `(hover: none)` devices never feed it. The file
  owns how far and how fast the eyes move (a gentle glance that never pins them to a corner,
  `assets/mascots/look.ts`); a mascot under a still pointer looks again at the next
  pointer move (scrolling does not).
