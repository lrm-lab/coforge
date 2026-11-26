import type { Dispatch, ReactNode, SetStateAction } from "react";

import { cardActor } from "./action-card-actor";
import { ActorName } from "#src/features/avatars/actor-name";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorAvatarStack, AVATAR_STACK_LIMIT } from "#src/features/avatars/actor-avatar-stack";
import { AVATAR_STACK_RING } from "#src/features/avatars/avatar-stack-ring";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import type {
  ActionCardPersonRef,
  ActionCardRef,
} from "#src/server/conversations/action-cards.server";
import { ActionCardAppBody } from "./action-card-app-body";
import { ChannelPlace } from "./channel-name";
import { GroupAvatar, type GroupAvatarMember } from "./group-avatar";
import { addMemberChannelName, type ToolActionCardView } from "./action-card-labels";
import { ActionCardDesktopTakeoverBody, ActionCardPageFillBody } from "./action-card-handoff";
import { ActionCardFeedbackBody, type FeedbackCardDraft } from "./action-card-feedback";

const listFormats = new Map<string, Intl.ListFormat>();

function listFormat() {
  const locale = getLocale();
  let format = listFormats.get(locale);
  if (!format) {
    format = new Intl.ListFormat(locale, { type: "conjunction" });
    listFormats.set(locale, format);
  }
  return format;
}

export function namesOf(people: ActionCardRef[]) {
  return listFormat().format(people.map((person) => person.displayName));
}

export function NamesWithFaces({
  people,
}: {
  people: (ActionCardPersonRef & { kind: "user" | "agent" })[];
}) {
  let next = 0;
  return listFormat()
    .formatToParts(people.map((person) => person.displayName))
    .map((part, index) =>
      part.type === "element" ? (
        <ActorName key={index} inline actor={cardActor(people[next]!, people[next++]!.kind)} />
      ) : (
        part.value
      ),
    );
}

function faceOf(person: ActionCardPersonRef) {
  return { id: person.id, name: person.displayName, avatarUrl: person.avatarUrl };
}

function Faces({ people, label }: { people: ActionCardPersonRef[]; label?: ReactNode }) {
  if (!people.length) return null;
  const shown = people.slice(0, AVATAR_STACK_LIMIT);
  const more = people.length - shown.length;
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <ActorAvatarStack more={more} className="shrink-0">
        {shown.map((person) => (
          <ActorAvatar
            presence={false}
            key={person.id}
            size="xs"
            src={person.avatarUrl ?? undefined}
            name={person.displayName}
            className={AVATAR_STACK_RING.outline}
          />
        ))}
      </ActorAvatarStack>
      <span className="min-w-0 text-xs text-tertiary">{label ?? namesOf(people)}</span>
    </div>
  );
}

export function ActionCardObject({
  view,
  fillValues,
  setFillValues,
  feedbackDraft,
  setFeedbackDraft,
  disabled,
}: {
  view: ToolActionCardView;
  fillValues: Record<string, string>;
  setFillValues: Dispatch<SetStateAction<Record<string, string>>>;
  feedbackDraft?: FeedbackCardDraft;
  setFeedbackDraft?: Dispatch<SetStateAction<FeedbackCardDraft>>;
  disabled?: boolean;
}) {
  const note = view.draftHint ? <p className="text-tertiary">{view.draftHint}</p> : null;
  let body: ReactNode = null;
  if (view.kind === "channel:create") {
    const newChannelFaces: GroupAvatarMember[] = [
      ...view.initialHumans.map((person) => ({ kind: "user" as const, ...faceOf(person) })),
      ...view.initialAgents.map((agent) => ({ kind: "agent" as const, ...faceOf(agent) })),
    ];
    body = (
      <>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-semibold text-primary">
          {newChannelFaces.length > 0 && (
            <GroupAvatar members={newChannelFaces} className="avatar-group-xs" />
          )}
          <span className="min-w-0 wrap-anywhere">{view.name}</span>
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
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm font-semibold text-primary">
              {namesOf([...view.humans, ...view.agents])} →
              {view.channel.id ? (
                <ChannelPlace id={view.channel.id} name={view.channel.displayName} />
              ) : (
                addMemberChannelName(view.channel)
              )}
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
  } else if (view.kind === "feedback:submit") {
    body = (
      <>
        <ActionCardFeedbackBody
          view={view}
          draft={feedbackDraft}
          setDraft={setFeedbackDraft}
          disabled={disabled}
        />
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
