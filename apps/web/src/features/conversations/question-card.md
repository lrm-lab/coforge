# Question cards

A `choice` or `questions` card an Agent posts is answered in the card itself, in the stream
(Frank, 2026-11-16; this replaced the 11-12 dock, which is gone). Rules an agent cannot read off
the code:

- One question shows at a time (`question-card-ask.tsx`). A card of several pages through them
  with the footer's pager and Skip, Next or, on the last, Send; a one-pick option turns to the next
  question by itself. On a card of one question, a one-pick option is the answer: picking it sends,
  so its rows are large, outlined and spaced apart against a mis-tap (Frank, 11-16).
- Enter sends what is ticked; it takes the highlighted row only when nothing is ticked yet.
- A multi-question card sizes to its tallest question from the start (a CSS grid stack with inert
  sizers), so paging never grows or shrinks the card or shifts the message stream on desktop or
  mobile.
- A card answered or declined while on screen keeps its height until the stream mounts it again
  (`useSettleInPlace`), so the messages below do not move: one question keeps its options with the
  pick marked, several turn into their answers. Mounted again it is compact (`data-question-card-view`).
- Say only what the card cannot show (`question-card-status.tsx`): when it was answered, whose face
  on someone else's, whom a waiting card waits on, why a gray one is gray. No counters or labels.
- Someone else's waiting card shows its options to look at, with nothing to pick and no decline.
- Keys go through the pure reducer in `question-card-keys.ts`, from anywhere in the card; the
  highlight shows only once keys are used, so nothing looks picked that was not. Esc goes back to
  the composer; Alt+↓/↑ goes to the next/previous card waiting on the viewer, and from the composer
  (caret at the end/start) to the first/last (`QuestionCardsHost`).
- Half-given answers are drafts on this device only (`question-drafts.ts`, localStorage key
  `coforge.question-draft:<messageId>`), dropped once the card stops waiting and pruned past the
  longest a card can wait. Syncing them across devices is a later change.
- "Don't answer" always asks first (`Popconfirm`, tone `final`: not red, since nothing is lost): a
  decline is final and wakes the Agent that asked. There is no undo window. The Activity inbox's
  waiting row declines with the same words.
- The card shows the Agent's own deadline (`view.deadline`) only while it waits; the 30-day default
  shows no time.
