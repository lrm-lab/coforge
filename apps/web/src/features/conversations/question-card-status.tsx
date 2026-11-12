import type { ReactNode } from "react";

import { ActorName } from "#src/features/avatars/actor-name";
import { messageSlots } from "#src/lib/message-slots";
import { m } from "#src/paraglide/messages";
import type { ActionCardActor } from "#src/server/conversations/action-card-view.server";
import { cardActor } from "./action-card-actor";
import type { AskingView } from "./question-dock-model";

/** The asked person by face and name, as every line that names someone shows them (task #521;
 * Frank, 11-12: a card waiting on someone shows whom). */
function withPerson(
  message: (slots: { name: string }) => string,
  person: ActionCardActor,
): ReactNode {
  return messageSlots(message, { name: <ActorName actor={cardActor(person)} inline /> });
}

/**
 * The few words a question card adds to what it shows (Frank, 11-12: as few as can be). Answers
 * in dark beside their questions show it was answered, so someone else's answered card shows only
 * whose they are, by face; a waiting card names whom it waits on; a gray one says why. Nothing on
 * the viewer's own card, whose Answer says the rest.
 */
export function cardStatus(view: AskingView, { mine }: { mine: boolean }): ReactNode {
  const asked = view.asked;
  switch (view.state) {
    case "pending":
      if (mine) return null;
      return asked ? withPerson(m.question_card_waiting_on, asked) : m.question_card_waiting();
    case "executed":
      // The answers beside the questions show it was answered; the head names only someone else.
      return mine || !asked ? null : <ActorName actor={cardActor(asked)} />;
    case "expired":
      return m.action_card_expired();
    case "cancelled":
      // The asked person said they would not answer; anyone else closing it withdrew it.
      if (asked && view.committedBy?.id === asked.id)
        return mine
          ? m.question_card_declined_you()
          : withPerson(m.question_card_declined_by, asked);
      return m.question_card_withdrawn();
  }
}
