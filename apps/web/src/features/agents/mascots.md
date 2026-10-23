# Mascots and the busy-Agents line

Part of [Agents UI](AGENTS.md). Rules for `src/features/agents/`.

- A mascot moves only where `AgentMascotView` draws it, through `AgentMascotAvatar`: message-stream
  avatars (`LiveAgentAvatar animated`), the Agent card, the profile card (not its header, which
  repeats it) and the busy-Agents line. It carries the Agent's mascot key (`LiveAgent.mascot`,
  the profile's `mascot`), never a URL to reverse, and is drawn bare: no tile, ring or clip. The
  Rive canvas mounts only while it is near the viewport, motion is allowed and the shared file
  loads (`mascot-rive.tsx`, the only `@rive-app/*` importer); anything else stays the still
  picture. Names: `mascot-contract.ts` and `mascot-rive-contract.ts`, shared with the generator
  (`assets/mascots/README.md`). The base `Avatar` draws any mascot picture (`isMascotPicture`)
  bare as well, so a list row, a group avatar or a picker shows it the same way; people keep their
  tile.
- `busy-agents-strip.tsx` is the line above a main composer naming the conversation's Agent
  members that are working or thinking, wherever they are busy: `busy-agents-summary.ts` (pure)
  filters and groups them by `agentDisplay` label (`activitySentenceLabel` words it for the
  sentence) and joins the names with `Intl.ListFormat`, the strip reads `useLiveAgents()`, and the
  conversation hands it only the member ids through `ConversationProps.aboveComposer` (the main
  pane only). One 24px mascot (`AgentMascotView`) cycles every 4s with a crossfade, the leaving
  one a still picture (`busy-agents-strip.css`); reduced motion stops the cycle and the fade. The
  sentence is plain text, not a live region; only the overflow count (`agent_busy_others`) is a
  message, the labels are not localized.
