import { Checkbox as AriaCheckbox } from "react-aria-components";

import { Avatar } from "#src/components/base/avatar/avatar";
import { BadgeWithButton } from "#src/components/base/badges/badges";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { memberMatchesSearch, type SearchableMember } from "./channel-member-search";
import type { loadPublicChannelMembers } from "./channels.functions";

type ChannelMembers = Awaited<ReturnType<typeof loadPublicChannelMembers>>;

/** One Workspace person or Agent who is not in the channel yet, as the pickers show them. */
export type ChannelCandidate = {
  /** Stable across the two kinds, which have their own id spaces. */
  key: string;
  kind: "user" | "agent";
  id: string;
  displayName: string;
  /** What the search reads: a person's display name, an Agent's name and handle. */
  search: SearchableMember;
  description?: string;
  avatarUrl?: string | null;
};

/** The one place the two id spaces are flattened into a candidate key; every producer and every
 * reader of a selection goes through it, so a chip, its row and `pickedMemberIds` cannot drift. */
export function candidateKey(kind: "user" | "agent", id: string) {
  return `${kind}:${id}`;
}

/** Agents first: adding an Agent to a channel is the common case, people the occasional one. */
export function buildChannelCandidates(
  candidates: ChannelMembers["candidates"],
): ChannelCandidate[] {
  return [
    ...candidates.agents.map((agent) => ({
      key: candidateKey("agent", agent.id),
      kind: "agent" as const,
      id: agent.id,
      displayName: agent.displayName,
      search: { kind: "agent" as const, displayName: agent.displayName, name: agent.name },
      description: agent.description,
      avatarUrl: agent.avatarUrl,
    })),
    ...candidates.humans.map((human) => ({
      key: candidateKey("user", human.id),
      kind: "user" as const,
      id: human.id,
      displayName: human.displayName,
      search: { kind: "user" as const, displayName: human.displayName },
      avatarUrl: human.avatarUrl,
    })),
  ];
}

/** A leading @ is how people write a handle; it is not part of the name. */
export function candidateSearchTerm(search: string) {
  return search.trim().replace(/^@/, "");
}

export function filterChannelCandidates(candidates: ChannelCandidate[], term: string) {
  const query = term.toLowerCase();
  return candidates.filter((entry) => memberMatchesSearch(query, entry.search));
}

/** The picked candidates as the `addPublicChannelMembers` and action-card commit inputs. A key a
 * refetch no longer lists (added meanwhile) drops out of the selection. */
export function pickedMemberIds(keys: Iterable<string>, byKey: Map<string, ChannelCandidate>) {
  const picked = [...keys].flatMap((key) => byKey.get(key) ?? []);
  return {
    userIds: picked.filter((entry) => entry.kind === "user").map((entry) => entry.id),
    agentIds: picked.filter((entry) => entry.kind === "agent").map((entry) => entry.id),
  };
}

/** What a picker's rows are inset by: a settings page's own padding, or a dialog's narrower body. */
type Inset = "page" | "dialog";

const insets: Record<Inset, string> = {
  page: "px-4 md:px-6",
  dialog: "px-2",
};

/** The picked people and Agents, each removable without hunting for its row in the list. */
export function ChannelCandidateChips({
  keys,
  byKey,
  disabled,
  onRemove,
}: {
  /** Selection order, so a chip stays where it appeared. */
  keys: string[];
  byKey: Map<string, ChannelCandidate>;
  disabled: boolean;
  onRemove: (key: string) => void;
}) {
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {keys.flatMap((key) => {
        const entry = byKey.get(key);
        if (!entry) return [];
        return [
          <BadgeWithButton
            key={key}
            size="sm"
            color={entry.kind === "agent" ? "brand" : "gray"}
            buttonLabel={m.channel_members_deselect({ name: entry.displayName })}
            onButtonClick={() => !disabled && onRemove(key)}
          >
            {entry.displayName}
          </BadgeWithButton>,
        ];
      })}
    </div>
  );
}

/** The candidates a search left, grouped into Agents and people, each a ticked row; plus the two
 * states that are not "no data": everyone is already a member, and this search matched nobody. */
export function ChannelCandidateGroups({
  candidates,
  shown,
  term,
  selected,
  disabled,
  onToggle,
  inset = "page",
}: {
  /** Every candidate, so "everyone is already in" is told apart from "no match". */
  candidates: ChannelCandidate[];
  shown: ChannelCandidate[];
  term: string;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (key: string, on: boolean) => void;
  inset?: Inset;
}) {
  const pad = insets[inset];
  const agents = shown.filter((entry) => entry.kind === "agent");
  const humans = shown.filter((entry) => entry.kind === "user");
  function row(entry: ChannelCandidate) {
    return (
      <ChannelCandidateRow
        key={entry.key}
        entry={entry}
        isSelected={selected.has(entry.key)}
        disabled={disabled}
        pad={pad}
        onToggle={onToggle}
      />
    );
  }
  return (
    <>
      {agents.length > 0 && (
        <>
          <h3 className={cn("py-2 text-xs font-semibold text-tertiary", pad)}>
            {m.channel_members_agents()}
          </h3>
          <ul>{agents.map(row)}</ul>
        </>
      )}
      {humans.length > 0 && (
        <>
          <h3 className={cn("py-2 text-xs font-semibold text-tertiary", pad)}>
            {m.channel_members_humans()}
          </h3>
          <ul>{humans.map(row)}</ul>
        </>
      )}
      {candidates.length === 0 && (
        <p className={cn("py-4 text-center text-sm text-tertiary", pad)}>
          {m.channel_members_all_added()}
        </p>
      )}
      {candidates.length > 0 && shown.length === 0 && (
        <p className={cn("py-4 text-center text-sm text-tertiary", pad)}>
          {m.channel_members_no_matches({ query: term })}
        </p>
      )}
    </>
  );
}

function ChannelCandidateRow({
  entry,
  isSelected,
  disabled,
  pad,
  onToggle,
}: {
  entry: ChannelCandidate;
  isSelected: boolean;
  disabled: boolean;
  pad: string;
  onToggle: (key: string, on: boolean) => void;
}) {
  const description = entry.description?.trim();
  // React Aria's checkbox around the official box, so the row can hold an avatar: the official
  // `Checkbox` puts its label in a `<p>`, which cannot contain the avatar's `<div>`.
  return (
    <li>
      <AriaCheckbox
        isSelected={isSelected}
        isDisabled={disabled}
        onChange={(on) => onToggle(entry.key, on)}
        aria-label={entry.displayName}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 py-2 hover:bg-primary_hover disabled:cursor-not-allowed",
          pad,
        )}
      >
        {({ isSelected: on, isDisabled, isFocusVisible }) => (
          <>
            <CheckboxBase isSelected={on} isDisabled={isDisabled} isFocusVisible={isFocusVisible} />
            <Avatar
              size="xs"
              alt=""
              src={entry.avatarUrl ?? undefined}
              initials={avatarInitial(entry.displayName)}
              contentClassName={avatarToneClassName(entry.displayName)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-primary">
                {entry.displayName}
              </span>
              {description && (
                <span className="block truncate text-xs text-tertiary">{description}</span>
              )}
            </span>
          </>
        )}
      </AriaCheckbox>
    </li>
  );
}
