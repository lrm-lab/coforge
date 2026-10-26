# Mascots and the replying line

Part of [Agents UI](AGENTS.md). Rules for `src/features/agents/`.

- A mascot animates where the surface shows the Agent's live state; lists and history stay static.
  It moves only where `AgentMascotView` draws it, and only on these surfaces: the replying lines
  (above a composer in the main pane and thread pane, and under a root in the stream), the chat
  list header's busy Agents (below) and the popovers listing them and a thread's following Agents
  (`AgentListRow` in `agent-list-popover.tsx`, given the Agent's `mascot`; the row's pointer state
  reaches it as `hovered`), the
  Direct-message list rows (`DirectAgentAvatar` in
  `features/conversations/`, through `AgentMascotAvatar`; the row's pointer state reaches it as
  `hovered` through `useRowHovered`, so a hover repaints only the mascot), the Agent's
  Direct-message header (`DirectConversationHeader`), the Agent profile panel header
  (`AgentProfileHeader`), the Agent hover card and the mascot picker (`agent-avatar-dialog.tsx`: all
  seven idle, the one under the pointer reacting, the selected one still moving). Everything else
  is static: the message stream, in channels and Direct messages alike (the still sticker,
  `LiveAgentAvatar`, `IdentityAvatar`), group avatars, search and members lists, and the profile
  card in the Profile tab (the header above it moves instead, so a panel shows one moving mascot).
  A deleted or archived Agent stays still and greyed. In a header the still picture also stays for
  an Agent whose mascot key is not known yet (no live entry, no profile mascot) and for an app bot,
  which has no mascot; another member's Agent animates there once its display is watched. A mascot carries the Agent's mascot
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
  (`AgentDisplayAvatar`, `AgentStackFace`), a channel's lone member and the replying line all
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
- `replying-agents-line.tsx` is the line along a composer's top edge, in the main pane and in a
  thread pane, saying which Agents are about to post in that place. The UI wording is "typing"
  ("Atlas, Ben and 2 other agents are typing…", `agent_replying_*`); in code it is a reply intent or
  "replying". The source is the Agent's "about to post" signal, not its activity: `reply-intents.ts`
  holds the entries (see [reply intents](../../../../../docs/observability/reply-intent.md)), the
  line shows those for the open conversation's top level or the open thread's root, and
  `replying-agents-summary.ts` (pure) picks the Agents the roster knows and words the names as Raft
  does: "Atlas, Ben and Cam" with no serial comma, "Atlas，Ben，Cam" in Chinese, and "正在输入"
  with no ellipsis. Above the composer it is a pill, as Frank drew it: a hairline-bordered rounded
  capsule, left-aligned, led by the first Agent's 20px moving mascot (`AgentMascotView` in an
  `AvatarSticker`, acting out `working`); the sentence names everyone and carries no activity
  label. Everyone who can read the place sees it, whether or not they can write there. It overlays
  the history's bottom padding (`pb-9`, the pill and its gap) and shares that row with the jump
  group, so the newest message is never covered while the pane follows it (scrolled up, it covers
  that strip) and the sentence truncates before the group; it renders nothing (and reads no roster)
  while nobody is replying. An Agent's own message arriving in that place ends one of its entries
  ([reply intents](../../../../../docs/observability/reply-intent.md)). The pill eases in and out
  (`replying-agents-line.css`) unless motion is reduced; the sentence is a polite `role="status"`
  for screen readers, and no other state (reading, working) appears in it.
- `ThreadReplyingLine` is the same line under a root's thread preview in the conversation's stream
  (never in a thread pane, which has its own), worded "is replying" (`agent_thread_replying_*`),
  for the Agents about to post in that root's thread; the Agent's reply arriving ends it, whether or
  not that reply is shown.
- Settings → Live agent activity (`features/settings/live-agent-activity.ts`, per device, on by
  default) hides the chat list header's busy Agents and both replying lines.
- A moving mascot's eyes follow the cursor. `mascot-look.ts` (pure) maps the pointer's offset from
  the canvas centre to `lookX` / `lookY` in [-1, 1] (full deflection at 350 px, flattening toward
  it), and `mascot-look-tracker.ts` is the one passive document `pointermove` listener every
  moving canvas shares: at most one pass per animation frame, writing the numbers straight into
  each instance's view model (never React state). The eyes ease back when the pointer leaves the
  window or the window blurs; touch pointers and `(hover: none)` devices never feed it. The file
  owns how far and how fast the eyes move (a gentle glance that never pins them to a corner,
  `assets/mascots/look.ts`); a mascot under a still pointer looks again at the next
  pointer move (scrolling does not).
