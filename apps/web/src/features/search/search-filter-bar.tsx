import { memo, type ReactNode, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, XClose } from "@untitledui/icons";
import { Button as AriaButton, ToggleButton as AriaToggleButton } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { channelLabel } from "#src/features/conversations/channel-visibility";
import {
  EntityPicker,
  Face,
  type PickerFace,
  type PickerOption,
} from "#src/features/pickers/entity-picker";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
  isSearchRange,
  SEARCH_RANGES,
  SEARCH_SCOPES,
  toggleScope,
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

const INACTIVE_CHIP_CLASS =
  "relative inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-secondary ring-1 ring-secondary ring-inset outline-focus-ring transition-colors duration-100 ease-linear hover:bg-primary_hover hover:text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 max-sm:h-9 max-sm:px-3 max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:-inset-y-1";

const ACTIVE_SHELL_CLASS =
  "inline-flex h-7 shrink-0 items-center rounded-lg bg-(--color-reference-bg) text-(--color-reference-text) ring-1 ring-(--color-reference-text)/35 ring-inset max-sm:h-9";

const ACTIVE_TRIGGER_CLASS =
  "relative inline-flex h-full cursor-pointer items-center gap-1.5 rounded-l-lg pl-2.5 pr-0.5 text-xs font-medium outline-focus-ring transition-colors duration-100 ease-linear hover:bg-(--color-reference-text)/10 focus-visible:outline-2 focus-visible:-outline-offset-2 max-sm:pl-3 max-sm:pr-0.5 max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:-inset-y-1";

const ACTIVE_CLEAR_CLASS =
  "relative inline-flex h-full cursor-pointer items-center justify-center rounded-r-lg pl-0.5 pr-2 text-(--color-reference-text)/80 outline-focus-ring transition-colors duration-100 ease-linear hover:bg-(--color-reference-text)/10 hover:text-(--color-reference-text) focus-visible:outline-2 focus-visible:-outline-offset-2 max-sm:pl-1 max-sm:pr-2.5 max-sm:after:absolute max-sm:after:-inset-x-1 max-sm:after:-inset-y-1";

/** The channel a search is limited to, as the directory names it. */
export function useSearchChannel(workspaceId: string, channelId: string | undefined) {
  return useQuery({
    ...searchDirectoryQuery(workspaceId),
    select: (directory) => directory.channels.find((candidate) => candidate.id === channelId),
    enabled: channelId !== undefined,
  }).data;
}

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

/**
 * The inline filter capsules directly under the search box: From, Channel, Time, the three Scope
 * toggles (`@ Me`, `Humans`, `Agents`), and Sort. Active capsules highlight in reference violet
 * and expose an inline `×` button to clear in one tap while keeping the main label pressable to
 * switch values. Wraps on wide screens and scrolls horizontally on phones.
 */
export const SearchFilterBar = memo(function SearchFilterBar({
  workspaceId,
  filters,
  onChange,
}: {
  workspaceId: string;
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
}) {
  const { directory, senders, sender, channel } = useFilterNames(workspaceId, filters);

  const senderOptions = useMemo<PickerOption[]>(
    () => [
      { id: ANY, label: m.search_from_anyone() },
      ...senders.map((candidate) => ({
        id: candidate.key,
        label: candidate.label,
        face: {
          kind: "identity" as const,
          name: candidate.name,
          src: candidate.avatarUrl,
          ...(candidate.kind === "agent" ? { agentId: candidate.id } : { userId: candidate.id }),
        },
        addon: candidate.addon,
        keywords: candidate.textValue,
      })),
    ],
    [senders],
  );

  const channelOptions = useMemo<PickerOption[]>(
    () => [
      { id: ANY, label: m.search_channel_any() },
      ...(directory?.channels ?? []).map((candidate) => ({
        id: candidate.id,
        label: candidate.name,
        ariaLabel: channelLabel(candidate),
        face: {
          kind: "channel" as const,
          visibility: candidate.visibility,
          members: candidate.members,
        },
        // The row's `#` is an icon; typing it still finds the channel.
        keywords: `#${candidate.name} ${candidate.description}`,
        addon: candidate.archived ? m.search_archived() : undefined,
      })),
    ],
    [directory?.channels],
  );

  const senderActive = filters.senderId !== undefined;
  const senderLabel = sender?.label ?? m.search_from();
  const senderFace: PickerFace | undefined = sender && {
    kind: "identity",
    name: sender.name,
    src: sender.avatarUrl,
    ...(sender.kind === "agent" ? { agentId: sender.id } : { userId: sender.id }),
  };

  const channelActive = filters.channelId !== undefined;
  const channelName = channel?.name ?? m.search_channel();
  const channelFace: PickerFace | undefined = channel?.members?.length
    ? {
        kind: "channel",
        visibility: channel.visibility,
        members: channel.members,
      }
    : undefined;

  const rangeLabel = filters.range ? RANGE_LABEL[filters.range]() : undefined;
  const recentSort = filters.sort === "recent";

  return (
    <div
      role="group"
      aria-label={m.search_filters()}
      className="flex flex-wrap items-center gap-1.5 max-sm:-mx-4 max-sm:-my-1 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:px-4 max-sm:py-1 max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden"
    >
      <FilterChipShell
        active={senderActive}
        clearLabel={m.search_chip_remove({
          name: sender ? m.search_chip_sender({ name: sender.label }) : m.search_from(),
        })}
        onClear={() => onChange(withSender(filters, undefined))}
      >
        <EntityPicker
          label={m.search_find_sender()}
          searchPlaceholder={m.search_find_sender()}
          selectedKey={sender?.key ?? (senderActive ? null : ANY)}
          placement="bottom start"
          className="w-72"
          options={senderOptions}
          onSelect={(key) => {
            const chosen = senders.find((candidate) => candidate.key === key);
            onChange(withSender(filters, chosen && { id: chosen.id, kind: chosen.kind }));
          }}
          trigger={
            <FilterTriggerButton
              active={senderActive}
              ariaLabel={sender ? m.search_from_named({ name: sender.label }) : m.search_from()}
              face={senderFace}
              label={senderActive ? senderLabel : m.search_from()}
            />
          }
        />
      </FilterChipShell>

      <FilterChipShell
        active={channelActive}
        clearLabel={m.search_chip_remove({ name: channelName })}
        onClear={() => onChange({ ...filters, channelId: undefined })}
      >
        <EntityPicker
          label={m.search_find_channel()}
          searchPlaceholder={m.search_find_channel()}
          selectedKey={filters.channelId ?? ANY}
          placement="bottom start"
          className="w-72"
          options={channelOptions}
          onSelect={(key) => onChange({ ...filters, channelId: key === ANY ? undefined : key })}
          trigger={
            <FilterTriggerButton
              active={channelActive}
              ariaLabel={
                channel ? `${m.search_channel()}: ${channelLabel(channel)}` : m.search_channel()
              }
              face={channelFace}
              label={channelActive ? channelName : m.search_channel()}
            />
          }
        />
      </FilterChipShell>

      <FilterChipShell
        active={rangeLabel !== undefined}
        clearLabel={rangeLabel ? m.search_chip_remove({ name: rangeLabel }) : ""}
        onClear={() => onChange({ ...filters, range: undefined })}
      >
        <Dropdown.Root>
          <FilterTriggerButton
            active={rangeLabel !== undefined}
            ariaLabel={rangeLabel ? `${m.search_time()}: ${rangeLabel}` : m.search_time()}
            label={rangeLabel ?? m.search_time()}
          />
          <Dropdown.Popover placement="bottom start" className="w-44">
            <Dropdown.Menu
              aria-label={m.search_time()}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[filters.range ?? ANY]}
              onAction={(key) =>
                onChange({ ...filters, range: isSearchRange(key) ? key : undefined })
              }
            >
              <Dropdown.Item id={ANY} label={m.search_time_any()} />
              {SEARCH_RANGES.map((range) => (
                <Dropdown.Item key={range} id={range} label={RANGE_LABEL[range]()} />
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      </FilterChipShell>

      {SEARCH_SCOPES.map((scope) => {
        const active = Boolean(filters.scope?.includes(scope));
        const label = SCOPE_LABEL[scope]();
        return (
          <AriaToggleButton
            key={scope}
            isSelected={active}
            onChange={() => onChange(toggleScope(filters, scope, sender?.kind))}
            className={cx(
              "relative inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg text-xs font-medium ring-1 ring-inset outline-focus-ring transition-colors duration-100 ease-linear focus-visible:outline-2 focus-visible:-outline-offset-2 max-sm:h-9 max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:-inset-y-1",
              active
                ? "bg-(--color-reference-bg) pl-2.5 pr-2 text-(--color-reference-text) ring-(--color-reference-text)/35 hover:bg-(--color-reference-bg) max-sm:pl-3 max-sm:pr-2.5"
                : "px-2.5 text-secondary ring-secondary hover:bg-primary_hover hover:text-primary max-sm:px-3",
            )}
          >
            <span>{label}</span>
            {active && <XClose aria-hidden="true" className="size-3 shrink-0 opacity-80" />}
          </AriaToggleButton>
        );
      })}

      <FilterChipShell
        active={recentSort}
        clearLabel={m.search_chip_remove({ name: m.search_sort_recent() })}
        onClear={() => onChange({ ...filters, sort: undefined })}
      >
        <Dropdown.Root>
          <FilterTriggerButton
            active={recentSort}
            ariaLabel={
              recentSort ? m.search_sort_named({ order: m.search_sort_recent() }) : m.search_sort()
            }
            label={recentSort ? m.search_sort_recent() : m.search_sort()}
          />
          <Dropdown.Popover placement="bottom end" className="w-40">
            <Dropdown.Menu
              aria-label={m.search_sort()}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[filters.sort ?? "relevance"]}
              onAction={(key) =>
                onChange({ ...filters, sort: key === "recent" ? "recent" : undefined })
              }
            >
              <Dropdown.Item id="relevance" label={m.search_sort_relevant()} />
              <Dropdown.Item id="recent" label={m.search_sort_recent()} />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
      </FilterChipShell>
    </div>
  );
});

function FilterChipShell({
  active,
  clearLabel,
  onClear,
  children,
}: {
  active: boolean;
  clearLabel: string;
  onClear: () => void;
  children: ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <div className={ACTIVE_SHELL_CLASS}>
      {children}
      <AriaButton aria-label={clearLabel} onPress={onClear} className={ACTIVE_CLEAR_CLASS}>
        <XClose aria-hidden="true" className="size-3 shrink-0" />
      </AriaButton>
    </div>
  );
}

function FilterTriggerButton({
  active,
  ariaLabel,
  face,
  label,
}: {
  active: boolean;
  ariaLabel: string;
  face?: PickerFace;
  label: string;
}) {
  return (
    <AriaButton
      aria-label={ariaLabel}
      className={cx(
        active ? ACTIVE_TRIGGER_CLASS : INACTIVE_CHIP_CLASS,
        face && "pl-1.5 max-sm:pl-2",
      )}
    >
      {face && <Face face={face} />}
      <span className={cx("whitespace-nowrap", active && "max-w-36 truncate")}>{label}</span>
      {!active && (
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
      )}
    </AriaButton>
  );
}
