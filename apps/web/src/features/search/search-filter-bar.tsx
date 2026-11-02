import { channelLabel } from "#src/features/conversations/channel-visibility";
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "@untitledui/icons";

import { EntityPicker } from "#src/features/pickers/entity-picker";
import { Button } from "#src/components/base/buttons/button";
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

/**
 * The filters under the search box: From, Scope, Channel, Time and Sort, then Clear all. Each
 * chip names its current value. Sort applies only to a query, so it is disabled without one.
 */
export function SearchFilterBar({
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
  const directory = useQuery(searchDirectoryQuery(workspaceId)).data;
  const senders = useMemo<Sender[]>(
    // The viewer first, as "Me".
    () => (directory ? directorySenders(directory, m.search_from_me()) : []),
    [directory],
  );
  const sender = senders.find((candidate) => candidate.id === filters.senderId);
  const channel = directory?.channels.find((candidate) => candidate.id === filters.channelId);
  const scopeCount = filters.scope?.length ?? 0;

  return (
    <div role="group" aria-label={m.search_filters()} className="flex flex-wrap items-center gap-2">
      <EntityPicker
        trigger={
          <Chip>{sender ? m.search_from_named({ name: sender.label }) : m.search_from()}</Chip>
        }
        label={m.search_find_sender()}
        searchPlaceholder={m.search_find_sender()}
        selectedKey={sender?.key ?? ANY}
        options={[
          { id: ANY, label: m.search_from_anyone() },
          ...senders.map((candidate) => ({
            id: candidate.key,
            label: candidate.label,
            face: { kind: "identity" as const, name: candidate.name, src: candidate.avatarUrl },
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
        <Chip>{scopeCount ? m.search_scope_count({ count: scopeCount }) : m.search_scope()}</Chip>
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
            label: channelLabel(candidate),
            keywords: `${candidate.name} ${candidate.description}`,
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
        onSelect={(key) => onChange({ ...filters, range: isSearchRange(key) ? key : undefined })}
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
        onSelect={(key) => onChange({ ...filters, sort: key === "recent" ? "recent" : undefined })}
      />
      {hasActiveFilter(filters) && (
        <Button size="sm" color="link-gray" onClick={() => onChange(clearedFilters(filters))}>
          {m.search_clear_filters()}
        </Button>
      )}
    </div>
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
      className="max-w-[16rem]"
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
