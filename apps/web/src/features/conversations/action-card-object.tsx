import type { Dispatch, ReactNode, SetStateAction } from "react";

import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type {
  ActionCardPersonRef,
  ActionCardRef,
} from "#src/server/conversations/action-cards.server";
import { ActionCardAppBody } from "./action-card-app-body";
import type { ToolActionCardView } from "./action-card-labels";
import { ActionCardDesktopTakeoverBody, ActionCardPageFillBody } from "./action-card-handoff";

const listFormats = new Map<string, Intl.ListFormat>();

/** The people a card names, as the names read in a sentence. */
export function namesOf(people: ActionCardRef[]) {
  const locale = getLocale();
  let format = listFormats.get(locale);
  if (!format) {
    format = new Intl.ListFormat(locale, { type: "conjunction" });
    listFormats.set(locale, format);
  }
  return format.format(people.map((person) => person.displayName));
}

/** A few faces and, as text, everyone they are. More than the faces shown still read in the names. */
function Faces({ people, label }: { people: ActionCardPersonRef[]; label?: ReactNode }) {
  if (!people.length) return null;
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <span className="flex shrink-0 gap-1">
        {people.slice(0, 4).map((person) => (
          <ActorAvatar
            presence={false}
            key={person.id}
            size="xs"
            src={person.avatarUrl ?? undefined}
            name={person.displayName}
          />
        ))}
      </span>
      <span className="min-w-0 text-xs text-tertiary">{label ?? namesOf(people)}</span>
    </div>
  );
}

/**
 * What the card would make, as an inset block: the thing itself, so the person decides on what they
 * see and not on a description of it (task #449). The Agent's note (`draftHint`) is shown only where
 * the card has no description of its own; it stays in the message's text for a screen reader.
 */
export function ActionCardObject({
  view,
  fillValues,
  setFillValues,
}: {
  view: ToolActionCardView;
  fillValues: Record<string, string>;
  setFillValues: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const note = view.draftHint ? <p className="text-tertiary">{view.draftHint}</p> : null;
  let body: ReactNode = null;
  if (view.kind === "channel:create") {
    body = (
      <>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-semibold text-primary">
          <span className="min-w-0 wrap-anywhere">#{view.name}</span>
          <span className="shrink-0 rounded-full border border-primary px-1.5 text-xs font-semibold text-tertiary">
            {view.visibility === "public" ? m.action_card_visibility_public() : m.channel_private()}
          </span>
        </p>
        {view.description ? <p className="text-tertiary">{view.description}</p> : note}
        <Faces people={[...view.initialHumans, ...view.initialAgents]} />
      </>
    );
  } else if (view.kind === "agent:create") {
    const computer = view.requiredComputer ?? view.suggestedComputer;
    body = (
      <>
        <p className="font-semibold wrap-anywhere text-primary">{view.name}</p>
        {view.description ? <p className="text-tertiary">{view.description}</p> : note}
        {computer && (
          <p className="text-tertiary">
            {view.requiredComputer
              ? m.action_card_required_computer({ name: computer.displayName })
              : m.action_card_suggested_computer({ name: computer.displayName })}
          </p>
        )}
      </>
    );
  } else if (view.kind === "channel:add_member") {
    body = (
      <>
        <Faces
          people={[...view.humans, ...view.agents]}
          label={
            <span className="text-sm font-semibold text-primary">
              {namesOf([...view.humans, ...view.agents])} → #{view.channel.displayName}
            </span>
          }
        />
        {note}
      </>
    );
  } else if (view.kind === "page:fill") {
    body = (
      <>
        <ActionCardPageFillBody view={view} fillValues={fillValues} setFillValues={setFillValues} />
        {note}
      </>
    );
  } else if (view.kind === "desktop:takeover") {
    body = (
      <>
        <ActionCardDesktopTakeoverBody view={view} />
        {note}
      </>
    );
  } else {
    body = (
      <>
        <ActionCardAppBody view={view} />
        {note}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-secondary px-3 py-2.5 text-sm wrap-anywhere text-secondary">
      {body}
    </div>
  );
}
