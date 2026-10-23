# Mascots and the busy-Agents line

Part of [Agents UI](AGENTS.md). Rules for `src/features/agents/`.

- A mascot moves only where `AgentMascotView` draws it, through `AgentMascotAvatar`: message-stream
  avatars (`LiveAgentAvatar animated`), the Agent card, the profile card (not its header, which
  repeats it) and the busy-Agents line. It carries the Agent's mascot key (`LiveAgent.mascot`,
  the profile's `mascot`), never a URL to reverse. The Rive canvas mounts only while it is near the
  viewport, motion is allowed and the shared file loads (`mascot-rive.tsx`, the only `@rive-app/*`
  importer); anything else stays the still picture. A moving mascot's eyes follow the cursor
  (below). Names: `mascot-contract.ts` and `mascot-rive-contract.ts`, shared with the generator
  (`assets/mascots/README.md`).
- Every Agent mascot is a sticker (Frank's references, 2026-10-23): `AvatarSticker`
  (`avatar-sticker.tsx`) is the one markup for it, the white-edged figure on a light backdrop
  circle at every size (`--color-avatar-backdrop`; profile sizes too, unlike a person's rounded
  square), drawn at 110% of the avatar, unclipped, so it passes the circle by only a few percent
  (`.avatar-sticker`, `.avatar-sticker-figure` in `styles.css`), with the status dot slot (a
  quarter of the avatar, on the circle at 45°). A picture that cannot load leaves the Agent's
  initial on the backdrop. The figure keeps one size and place in every activity: a change only
  reshapes the face, poses an accessory, mutes the colours or shows the thinking bubble, which
  stays inside the circle. The moving avatar (`AgentMascotAvatar`), the still one
  (`AgentDisplayAvatar`, `AgentStackFace`), a channel's lone member and the busy-Agents line all
  draw through it. Anywhere a picture may be a person's or an Agent's, features use
  `IdentityAvatar`, which sends a mascot picture (`isMascotPicture`) to the sticker and anything
  else to the base `Avatar` (`deleted` greys either); the base `Avatar` and the other base
  components know nothing of mascots, so a feature draws an Agent's face itself (the task
  assignee menu passes `assigneeFace` as the item icon). Places that only ever show people keep
  the base `Avatar`. A channel's group avatar
  puts its members' stickers on the same backdrop (`group-avatar.tsx`, `collage-layout.ts`): a
  person there is their round photo with a white edge. Stacked faces carry the stack's
  page-coloured separator ring. The picker (`avatar-choice.tsx`) shows the plain picture on its
  own selection tile.
- `busy-agents-strip.tsx` is the line above a main composer naming the conversation's Agent
  members that are working or thinking, wherever they are busy: `busy-agents-summary.ts` (pure)
  filters and groups them by `agentDisplay` label (`activitySentenceLabel` words it for the
  sentence) and joins the names with `Intl.ListFormat`, the strip reads `useLiveAgents()`, and the
  conversation hands it only the member ids through `ConversationProps.aboveComposer` (the main
  pane only). One 24px mascot sticker (`AgentMascotView`) cycles every 4s with a crossfade, the leaving
  one a still picture (`busy-agents-strip.css`); reduced motion stops the cycle and the fade. The
  sentence is plain text, not a live region; only the overflow count (`agent_busy_others`) is a
  message, the labels are not localized.
- A moving mascot's eyes follow the cursor. `mascot-look.ts` (pure) maps the pointer's offset from
  the canvas centre to `lookX` / `lookY` in [-1, 1] (full deflection at 300 px, flattening toward
  it), and `mascot-look-tracker.ts` is the one passive document `pointermove` listener every
  moving canvas shares: at most one pass per animation frame, writing the numbers straight into
  each instance's view model (never React state). The eyes ease back when the pointer leaves the
  window or the window blurs; touch pointers and `(hover: none)` devices never feed it. The file
  owns how far and how fast the eyes move; a mascot under a still pointer looks again at the next
  pointer move (scrolling does not).
