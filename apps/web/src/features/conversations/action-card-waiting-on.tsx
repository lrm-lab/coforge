import { ActorName } from "#src/features/avatars/actor-name";
import type { ActionCardActor } from "#src/server/conversations/action-card-view.server";
import { messageSlots } from "#src/lib/message-slots";
import { m } from "#src/paraglide/messages";
import { cardActor } from "./action-card-actor";

/**
 * Whom a pending card waits on, for anyone but the asked person (task #521: a line that names
 * someone carries their face). The face stands inside the sentence, before the name, in place of
 * the clock the line used to start with: the clock only said "waiting", which the words already
 * do, and two icons in one small line read as noise.
 */
export function WaitingOn({ asked }: { asked: ActionCardActor }) {
  return (
    <p className="flex min-w-0 flex-1 items-center text-xs text-tertiary">
      <span className="min-w-0 truncate">
        {messageSlots(m.action_card_choice_waiting, {
          name: <ActorName actor={cardActor(asked)} />,
        })}
      </span>
    </p>
  );
}
