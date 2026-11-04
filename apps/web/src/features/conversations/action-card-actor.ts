import type { NamedActor } from "#src/features/avatars/actor-name";
import type { ActionCardPersonRef } from "#src/server/conversations/action-card-view.server";

/** A person (or Agent) a card names, as `ActorName` draws them (task #521). A card's asker and
 * answerer are always people; the add-member card's list passes the kind of each. */
export function cardActor(
  person: ActionCardPersonRef,
  kind: NamedActor["kind"] = "user",
): NamedActor {
  return { kind, id: person.id, name: person.displayName, avatarUrl: person.avatarUrl };
}
