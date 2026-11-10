import { channelLabel } from "#src/features/conversations/channel-visibility";
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FilterLines, XClose } from "@untitledui/icons";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";

import { ActorName } from "#src/features/avatars/actor-name";
import { messageSlots } from "#src/lib/message-slots";
import { EntityPicker } from "#src/features/pickers/entity-picker";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import {
  clearedFilters,
  hasActiveFilter,
  isSearchRange,
  SEARCH_RANGES,
  SEARCH_SCOPES,
  withScope,
  withSender,
  type SearchFilters,
  type SearchRange,
  type SearchScope,
} from "./search-filters";
import { searchDirectoryQuery } from "./search-queries";
import { directorySenders, type Sender } from "./search-senders";

const ANY = "any";

const RANGE_LABEL: Record<SearchRange, () => string> = {
  today: () => m.search_time_today(),
  "7d": () => m.search_time_last_7_days(),
  "30d": () => m.search_time_last_30_days(),
};

const SCOPE_LABEL: Record<SearchScope, () => string> = {
  mentioned: () => m.search_scope_mentioned(),
  humans: () => m.search_scope_humans(),
  agents: () => m.search_scope_agents(),
};

function useFilterNames(workspaceId: string, filters: SearchFilters) {
  const directory = useQuery(searchDirectoryQuery(workspaceId)).data;
  const senders = useMemo<Sender[]>(
    // The viewer first, as "Me".
    () => (directory ? directorySenders(directory, m.search_from_me()) : []),
    [directory],
  );
  return {
    directory,
    senders,
    sender: senders.find((candidate) => candidate.id === filters.senderId),
    channel: directory?.channels.find((candidate) => candidate.id === filters.channelId),
  };
}

/** What is filtered, each in a full phrase; pressing one removes it. Nothing without a filter. */
export function SearchFilterChips({
  workspaceId,
  filters,
  onChange,
}: {
  workspaceId: string;
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
}) {
  const { sender, channel } = useFilterNames(workspaceId, filters);
  const chips = [
    sender && {
      name: m.search_chip_sender({ name: sender.label }),
      next: withSender(filters, undefined),
    },
    ...(filters.scope ?? []).map((scope) => ({
      name: SCOPE_LABEL[scope](),
      next: withScope(
        filters,
        (filters.scope ?? []).filter((other) => other !== scope),
        sender?.kind,
      ),
    })),
    channel && { name: channelLabel(channel), next: { ...filters, channelId: undefined } },
    filters.range && { name: RANGE_LABEL[filters.range](), next: { ...filters, range: undefined } },
    filters.sort === "recent" && {
      name: m.search_sort_recent(),
      next: { ...filters, sort: undefined },
    },
  ].filter((chip) => !!chip);
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label={m.search_filters()} className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <AriaButton
          key={chip.name}
          aria-label={m.search_chip_remove({ name: chip.name })}
          onPress={() => onChange(chip.next)}
          className="inline-flex max-w-[16rem] cursor-pointer items-center gap-1 rounded-lg bg-brand-primary_alt px-2 py-1 text-xs font-medium text-fg-brand-primary outline-focus-ring focus-visible:outline-2"
        >
          <span className="truncate">{chip.name}</span>
          <XClose aria-hidden="true" className="size-3 shrink-0" />
        </AriaButton>
      ))}
    </div>
  );
}

/** The filter button beside the search box and, behind it, the filters laid flat: time, scope and
 * sort, which have few choices, as one press each; the sender and the channel, which have many, as
 * rows that open a searchable list. Sort applies only to a query, so it is disabled without one. */
export function SearchFilterMenu({
  workspaceId,
  query,
  filters,
  onChange,
}: {
  workspaceId: string;
  query: string;
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
}) {
  const { directory, senders, sender, channel } = useFilterNames(workspaceId, filters);

  return (
    <DialogTrigger>
      <ButtonUtility
        icon={FilterLines}
        size="sm"
        color="tertiary"
        tooltip={m.search_filter_open()}
        aria-label={m.search_filter_open()}
      />
      <AriaPopover
        placement="bottom end"
        className="rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt"
      >
        <AriaDialog
          aria-label={m.search_filters()}
          className="flex w-80 flex-col items-stretch gap-1 p-2 outline-hidden"
        >
          <FilterSection label={m.search_time()}>
            <ChoiceGroup
              label={m.search_time()}
              selected={[filters.range ?? ANY]}
              options={[
                { key: ANY, label: m.search_time_any() },
                ...SEARCH_RANGES.map((range) => ({ key: range, label: RANGE_LABEL[range]() })),
              ]}
              onChange={([key]) =>
                onChange({ ...filters, range: key && isSearchRange(key) ? key : undefined })
              }
            />
          </FilterSection>
          <FilterSection label={m.search_scope()}>
            <ChoiceGroup
              label={m.search_scope()}
              multiple
              selected={filters.scope?.length ? filters.scope : [ANY]}
              options={[
                { key: ANY, label: m.search_scope_all() },
                ...SEARCH_SCOPES.map((scope) => ({ key: scope, label: SCOPE_LABEL[scope]() })),
              ]}
              onChange={(keys, added) =>
                // "All" is no scope at all: choosing it clears the rest, choosing any other leaves it.
                onChange(
                  withScope(
                    filters,
                    added === ANY ? [] : keys.filter((key) => key !== ANY),
                    sender?.kind,
                  ),
                )
              }
            />
          </FilterSection>
          <div className="my-1 h-px bg-border-secondary" />
          <EntityPicker
            trigger={
              <FilterRow>
                {sender
                  ? messageSlots(m.search_from_named, {
                      // The face before the name in the row (task #521).
                      name: (
                        <ActorName
                          actor={{
                            kind: sender.kind,
                            id: sender.id,
                            name: sender.label,
                            avatarUrl: sender.avatarUrl,
                          }}
                        />
                      ),
                    })
                  : m.search_from()}
              </FilterRow>
            }
            label={m.search_find_sender()}
            searchPlaceholder={m.search_find_sender()}
            selectedKey={sender?.key ?? ANY}
            options={[
              { id: ANY, label: m.search_from_anyone() },
              ...senders.map((candidate) => ({
                id: candidate.key,
                label: candidate.label,
                face: {
                  kind: "identity" as const,
                  name: candidate.name,
                  src: candidate.avatarUrl,
                  ...(candidate.kind === "agent"
                    ? { agentId: candidate.id }
                    : { userId: candidate.id }),
                },
                addon: candidate.addon,
                keywords: candidate.textValue,
              })),
            ]}
            onSelect={(key) => {
              const chosen = senders.find((candidate) => candidate.key === key);
              onChange(withSender(filters, chosen && { id: chosen.id, kind: chosen.kind }));
            }}
          />
          <EntityPicker
            trigger={<FilterRow>{channel ? channelLabel(channel) : m.search_channel()}</FilterRow>}
            label={m.search_find_channel()}
            searchPlaceholder={m.search_find_channel()}
            selectedKey={filters.channelId ?? ANY}
            options={[
              { id: ANY, label: m.search_channel_any() },
              ...(directory?.channels ?? []).map((candidate) => ({
                id: candidate.id,
                label: candidate.name,
                ariaLabel: channelLabel(candidate),
                face: { kind: "channel" as const, visibility: candidate.visibility },
                // The row's `#` is an icon; typing it still finds the channel.
                keywords: `#${candidate.name} ${candidate.description}`,
                addon: candidate.archived ? m.search_archived() : undefined,
              })),
            ]}
            onSelect={(key) => onChange({ ...filters, channelId: key === ANY ? undefined : key })}
          />
          <div className="my-1 h-px bg-border-secondary" />
          <FilterSection label={m.search_sort()}>
            <ChoiceGroup
              label={m.search_sort()}
              disabled={!query}
              selected={[filters.sort ?? "relevance"]}
              options={[
                { key: "relevance", label: m.search_sort_relevant() },
                { key: "recent", label: m.search_sort_recent() },
              ]}
              onChange={([key]) =>
                onChange({ ...filters, sort: key === "recent" ? "recent" : undefined })
              }
            />
          </FilterSection>
          {hasActiveFilter(filters) && (
            <Button size="sm" color="link-gray" onClick={() => onChange(clearedFilters(filters))}>
              {m.search_clear_filters()}
            </Button>
          )}
        </AriaDialog>
      </AriaPopover>
    </DialogTrigger>
  );
}

function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      <span aria-hidden="true" className="text-xs font-medium text-tertiary">
        {label}
      </span>
      {children}
    </div>
  );
}

/** A filter with few choices, each one press: a single choice, or several (`multiple`). */
function ChoiceGroup({
  label,
  multiple,
  disabled,
  selected,
  options,
  onChange,
}: {
  label: string;
  multiple?: boolean;
  disabled?: boolean;
  selected: string[];
  options: { key: string; label: string }[];
  /** The keys now chosen, and the one this press added, if any. */
  onChange: (keys: string[], added: string | undefined) => void;
}) {
  return (
    <ButtonGroup
      size="sm"
      aria-label={label}
      selectionMode={multiple ? "multiple" : "single"}
      disallowEmptySelection={!multiple}
      isDisabled={disabled}
      selectedKeys={selected}
      onSelectionChange={(keys) => {
        const next = [...keys].map(String);
        onChange(
          next,
          next.find((key) => !selected.includes(key)),
        );
      }}
      className="w-full"
    >
      {options.map((option) => (
        <ButtonGroupItem
          key={option.key}
          id={option.key}
          className="min-w-0 flex-1 justify-center px-2"
        >
          <span className="truncate">{option.label}</span>
        </ButtonGroupItem>
      ))}
    </ButtonGroup>
  );
}

/** A filter with many choices: a row naming what is chosen, opening its searchable list. */
function FilterRow({ children }: { children: ReactNode }) {
  return (
    <Button
      size="sm"
      color="tertiary"
      iconTrailing={ChevronRight}
      className="w-full justify-between"
    >
      {children}
    </Button>
  );
}
