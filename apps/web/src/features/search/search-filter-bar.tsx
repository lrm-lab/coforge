import { channelLabel } from "#src/features/conversations/channel-visibility";
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FilterLines, XClose } from "@untitledui/icons";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";

import { ActorName } from "#src/features/avatars/actor-name";
import { messageSlots } from "#src/lib/message-slots";
import { EntityPicker } from "#src/features/pickers/entity-picker";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
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
          className="inline-flex max-w-[16rem] cursor-pointer items-center gap-1 rounded-lg bg-brand-50 px-2 py-1 text-xs font-medium text-brand-600 outline-focus-ring focus-visible:outline-2 dark:bg-brand-950 dark:text-brand-400"
        >
          <span className="truncate">{chip.name}</span>
          <XClose aria-hidden="true" className="size-3 shrink-0" />
        </AriaButton>
      ))}
    </div>
  );
}

/** The filter button beside the search box and, behind it, the sender, scope, channel, time and
 * sort. Sort applies only to a query, so it is disabled without one. */
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
  const scopeCount = filters.scope?.length ?? 0;

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
          className="flex w-60 flex-col items-stretch gap-2 p-2 outline-hidden"
        >
          <EntityPicker
            trigger={
              <Chip>
                {sender
                  ? messageSlots(m.search_from_named, {
                      // The face before the name in the chip (task #521).
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
              </Chip>
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
          <Dropdown.Root>
            <Chip>
              {scopeCount ? m.search_scope_count({ count: scopeCount }) : m.search_scope()}
            </Chip>
            <Dropdown.Popover placement="bottom start" className="w-56">
              <Dropdown.Menu
                aria-label={m.search_scope()}
                selectionMode="multiple"
                selectedKeys={filters.scope ?? []}
                shouldCloseOnSelect={false}
                onSelectionChange={(keys) => {
                  if (keys === "all") return;
                  onChange(withScope(filters, keys, sender?.kind));
                }}
              >
                {SEARCH_SCOPES.map((scope) => (
                  <Dropdown.Item
                    key={scope}
                    id={scope}
                    label={SCOPE_LABEL[scope]()}
                    selectionIndicator="checkbox"
                  />
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
          <EntityPicker
            trigger={<Chip>{channel ? channelLabel(channel) : m.search_channel()}</Chip>}
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
          <SingleChoiceChip
            ariaLabel={m.search_time()}
            label={filters.range ? RANGE_LABEL[filters.range]() : m.search_time()}
            selectedKey={filters.range ?? ANY}
            options={[
              { key: ANY, label: m.search_time_any() },
              ...SEARCH_RANGES.map((range) => ({ key: range, label: RANGE_LABEL[range]() })),
            ]}
            onSelect={(key) =>
              onChange({ ...filters, range: isSearchRange(key) ? key : undefined })
            }
          />
          <SingleChoiceChip
            ariaLabel={m.search_sort()}
            label={m.search_sort_named({
              order: filters.sort === "recent" ? m.search_sort_recent() : m.search_sort_relevant(),
            })}
            disabled={!query}
            selectedKey={filters.sort ?? "relevance"}
            options={[
              { key: "relevance", label: m.search_sort_relevant() },
              { key: "recent", label: m.search_sort_recent() },
            ]}
            onSelect={(key) =>
              onChange({ ...filters, sort: key === "recent" ? "recent" : undefined })
            }
          />
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

/**
 * A filter chip: the trigger button of its menu. A toolbar button stays secondary (design §11),
 * so the label, which names the chosen value, is what shows a filter is set.
 */
function Chip({ disabled, children }: { disabled?: boolean; children: ReactNode }) {
  return (
    <Button
      size="sm"
      color="secondary"
      iconTrailing={ChevronDown}
      isDisabled={disabled}
      className="w-full justify-between"
    >
      {children}
    </Button>
  );
}

function SingleChoiceChip({
  ariaLabel,
  label,
  disabled,
  selectedKey,
  options,
  onSelect,
}: {
  ariaLabel: string;
  label: string;
  disabled?: boolean;
  selectedKey: string;
  options: { key: string; label: string }[];
  onSelect: (key: string) => void;
}) {
  return (
    <Dropdown.Root>
      <Chip disabled={disabled}>{label}</Chip>
      <Dropdown.Popover placement="bottom start" className="w-48">
        <Dropdown.Menu
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={[selectedKey]}
          onAction={(key) => onSelect(String(key))}
        >
          {options.map((option) => (
            <Dropdown.Item key={option.key} id={option.key} label={option.label} />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
