# Question cards and the dock

A `choice` or `questions` card an Agent posts is answered in the pane's dock, never inline in the
stream (Frank, 2026-11-12). Rules an agent cannot read off the code:

- The stream card (`question-card.tsx`) is a summary: each question with its answer beside it,
  and one line after them for the next step (`question-card-status.tsx`). Say only what
  the card cannot show: answers in dark mean answered, a gray card means nobody will answer it, and
  a person the line names is drawn by face (`ActorName`). Add no counters or state labels.
- A card answered while it is on screen keeps its height until the stream mounts it again (`useSettleInPlace`), so the messages below do not move when its Answer line goes.
- `QuestionDockHost` is per pane and owns which card is open, at which question. On a desktop the
  dock takes the composer's place; the composer is hidden (`contents sm:hidden`), never unmounted,
  so its draft survives, and closing the dock gives focus back to it. On a phone the dock is a
  bottom sheet over the stream.
- Escape closes an open desktop dock wherever focus is in its pane, or, when focus is nowhere,
  the dock opened last (`QuestionDockHost`, task #109): a stream refresh that swaps the dock's view, or a click on the
  stream, takes focus off the dock, and the key must still work.
- The dock keeps one height for its whole life, so nothing above it moves as questions, cards and
  the receipt change; only its first open animates.
- Half-given answers are drafts on this device only (`question-drafts.ts`, localStorage key
  `coforge.question-draft:<messageId>`), dropped once the card stops waiting and pruned past the
  longest a card can wait. Syncing them across devices is a later change.
- Keys go through the pure reducer in `question-dock-keys.ts`; the highlight shows only once keys
  are used, so nothing looks picked that was not.
- "Don't answer" always asks first (`Popconfirm`): a decline is final and wakes the Agent that
  asked. There is no undo window. The Activity inbox's waiting row declines the same way.
- The card shows the Agent's own deadline (`view.deadline`) only while it waits; the 30-day default
  shows no time.
