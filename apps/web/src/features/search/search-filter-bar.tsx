import { channelLabel } from "#src/features/conversations/channel-visibility";
import { useMemo, useState, type FC, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FilterLines, Hash02, User01, XClose } from "@untitledui/icons";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";

import { ActorName } from "#src/features/avatars/actor-name";
import { PickerMenu } from "#src/features/pickers/entity-picker";
import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { GroupAvatar } from "#src/features/conversations/group-avatar";
import { useLiveChannelRow } from "#src/features/conversations/sidebar-lists";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
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
  const chips: { name: string; next: SearchFilters; channelId?: string }[] = [
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
    channel && {
      // As the sidebar draws it: its group avatar and its name, no `#` (Frank, 11-10).
      name: channel.name,
      next: { ...filters, channelId: undefined },
      channelId: channel.id,
    },
    filters.range && { name: RANGE_LABEL[filters.range](), next: { ...filters, range: undefined } },
    filters.sort === "recent" && {
      name: m.search_sort_recent(),
      next: { ...filters, sort: undefined },
    },
  ].filter((chip) => !!chip);
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label={m.search_filters()} className="flex flex-wrap gap-2 lg:pb-3">
      {chips.map((chip) => (
        <AriaButton
          key={chip.name}
          aria-label={m.search_chip_remove({ name: chip.name })}
          onPress={() => onChange(chip.next)}
          className="inline-flex max-w-[16rem] cursor-pointer items-center gap-1 rounded-lg bg-brand-primary_alt px-2 py-1 text-xs font-medium text-fg-brand-primary outline-focus-ring focus-visible:outline-2"
        >
          {chip.channelId && <ChannelChipAvatar channelId={chip.channelId} />}
          <span className="truncate">{chip.name}</span>
          <XClose aria-hidden="true" className="size-3 shrink-0" />
        </AriaButton>
      ))}
    </div>
  );
}

/** A channel chip's group avatar, from the sidebar's row; none until the row is known. */
function ChannelChipAvatar({ channelId }: { channelId: string }) {
  const members = useLiveChannelRow(channelId)?.members;
  return members?.length ? <GroupAvatar members={members} className="avatar-group-xs" /> : null;
}

/** The filter button beside the search box and, behind it, the filters (design B, task #46): time
 * and scope, which have few choices, as pills that wrap; the sender and the channel, which have
 * many, as rows that turn the menu into their searchable list and come back once one is picked;
 * the sort last. Sort applies only to a query, so it is disabled without one. */
export function SearchFilterMenu({
  workspaceId,
  query,
  filters,
  onChange,
  besideRef,
}: {
  workspaceId: string;
  query: string;
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  /** The search dialog: where the window has room on its side, the filters open beside it, level
   * with its top (Frank, 11-10), not hanging past its edge; otherwise under the button. */
  besideRef: RefObject<Element | null>;
}) {
  const wide = useBreakpoint("sm");
  // The 40rem panel is centered, so each side keeps half of what is left: the 18rem menu and its
  // gap fit there from `xl`. Below that, beside the panel it was cut off at the window's edge.
  const beside = useBreakpoint("xl");
  const { directory, senders, sender, channel } = useFilterNames(workspaceId, filters);
  const [list, setList] = useState<"sender" | "channel">();

  const body = (
    <>
      {list === "sender" ? (
        <FilterList label={m.search_from()} onBack={() => setList(undefined)}>
          <PickerMenu
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
            onClose={() => setList(undefined)}
            // On a phone, typing waits for a tap: focus would raise the keyboard over the list.
            autoFocus={wide}
          />
        </FilterList>
      ) : list === "channel" ? (
        <FilterList label={m.search_channel()} onBack={() => setList(undefined)}>
          <PickerMenu
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
            onClose={() => setList(undefined)}
            // On a phone, typing waits for a tap: focus would raise the keyboard over the list.
            autoFocus={wide}
          />
        </FilterList>
      ) : (
        <>
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
          <Separator />
          <FilterRow
            icon={User01}
            label={m.search_from()}
            value={
              sender && (
                // The face before the name (task #521).
                <ActorName
                  actor={{
                    kind: sender.kind,
                    id: sender.id,
                    name: sender.label,
                    avatarUrl: sender.avatarUrl,
                  }}
                />
              )
            }
            fallback={m.search_from_anyone()}
            onPress={() => setList("sender")}
          />
          <FilterRow
            icon={Hash02}
            label={m.search_channel()}
            value={channel?.name}
            fallback={m.search_channel_any()}
            onPress={() => setList("channel")}
          />
          <Separator />
          <FilterSection label={m.search_sort()}>
            <SortControl
              disabled={!query}
              selected={filters.sort ?? "relevance"}
              onChange={(sort) =>
                onChange({ ...filters, sort: sort === "recent" ? "recent" : undefined })
              }
            />
          </FilterSection>
        </>
      )}
    </>
  );
  const trigger = (
    <ButtonUtility
      icon={FilterLines}
      size="sm"
      color="tertiary"
      tooltip={m.search_filter_open()}
      aria-label={m.search_filter_open()}
    />
  );
  const menu = "flex flex-col items-stretch p-1.5 outline-hidden";

  return (
    <DialogTrigger onOpenChange={() => setList(undefined)}>
      {trigger}
      {wide ? (
        <AriaPopover
          triggerRef={beside ? besideRef : undefined}
          placement={beside ? "end top" : "bottom end"}
          className="rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt"
        >
          <AriaDialog
            aria-label={m.search_filters()}
            data-search-filter-menu=""
            className={cx(menu, "w-72")}
          >
            {body}
          </AriaDialog>
        </AriaPopover>
      ) : (
        // A phone: a sheet from the bottom edge, the width of the screen, as every picker there.
        <ModalOverlay isDismissable className="px-0 [--modal-pb:0px]">
          <Modal className="w-full rounded-t-2xl rounded-b-none">
            <Dialog
              aria-label={m.search_filters()}
              data-search-filter-menu=""
              className={cx(menu, "pb-safe-bottom")}
            >
              <div
                aria-hidden="true"
                className="mx-auto mt-0.5 mb-1.5 h-1 w-9 rounded-full bg-quaternary/40"
              />
              {body}
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
    </DialogTrigger>
  );
}

function Separator() {
  return <div className="-mx-1.5 my-1.5 h-px bg-border-secondary" />;
}

function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-2.5 pt-2 pb-1.5">
      <span aria-hidden="true" className="text-xs text-tertiary">
        {label}
      </span>
      {children}
    </div>
  );
}

/** A filter with few choices, each a pill of its own that wraps to the next line rather than be
 * cut short: a single choice, or several (`multiple`). */
function ChoiceGroup({
  label,
  multiple,
  selected,
  options,
  onChange,
}: {
  label: string;
  multiple?: boolean;
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
      selectedKeys={selected}
      onSelectionChange={(keys) => {
        const next = [...keys].map(String);
        onChange(
          next,
          next.find((key) => !selected.includes(key)),
        );
      }}
      className="w-full flex-wrap gap-1.5 space-x-0 shadow-none"
    >
      {options.map((option) => (
        <ButtonGroupItem
          key={option.key}
          id={option.key}
          // What is picked is content the person chose: the reference violet, as in the mockup.
          className="h-7 rounded-lg px-2.5 py-0 max-sm:h-9 max-sm:px-3.5 font-medium shadow-none ring-secondary not-last:pr-2.5 first:rounded-lg last:rounded-lg selected:bg-(--color-reference-bg) selected:text-(--color-reference-text) selected:ring-(--color-reference-text)/40"
        >
          {option.label}
        </ButtonGroupItem>
      ))}
    </ButtonGroup>
  );
}

/** Relevance or newest first: a segmented control, as Untitled's bordered tabs. */
function SortControl({
  disabled,
  selected,
  onChange,
}: {
  disabled: boolean;
  selected: string;
  onChange: (sort: string) => void;
}) {
  return (
    <ButtonGroup
      size="sm"
      aria-label={m.search_sort()}
      disallowEmptySelection
      isDisabled={disabled}
      selectedKeys={[selected]}
      onSelectionChange={(keys) => {
        const [key] = [...keys].map(String);
        if (key) onChange(key);
      }}
      className="w-full gap-0.5 space-x-0 rounded-lg bg-secondary_alt p-0.5 shadow-none ring-1 ring-secondary ring-inset"
    >
      {[
        { key: "relevance", label: m.search_sort_relevant() },
        { key: "recent", label: m.search_sort_recent() },
      ].map((option) => (
        <ButtonGroupItem
          key={option.key}
          id={option.key}
          className="flex-1 justify-center rounded-md bg-transparent px-3 py-1.5 max-sm:py-2.5 text-tertiary shadow-none ring-0 not-last:pr-3 first:rounded-md last:rounded-md hover:bg-transparent hover:text-secondary selected:bg-primary_alt selected:text-secondary selected:shadow-sm"
        >
          {option.label}
        </ButtonGroupItem>
      ))}
    </ButtonGroup>
  );
}

/** A filter with many choices: its name, what is chosen, and a chevron to its list. */
function FilterRow({
  icon: Icon,
  label,
  value,
  fallback,
  onPress,
}: {
  icon: FC<{ className?: string }>;
  label: string;
  value: ReactNode;
  fallback: string;
  onPress: () => void;
}) {
  return (
    <AriaButton
      onPress={onPress}
      className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-secondary max-sm:h-11 max-sm:text-md outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
      <span className="shrink-0">{label}</span>
      <span
        className={cx(
          "ml-auto min-w-0 truncate",
          value ? "font-medium text-(--color-reference-text)" : "text-tertiary",
        )}
      >
        {value ?? fallback}
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
    </AriaButton>
  );
}

/** A filter's list in place of the menu, under a row back to it. */
function FilterList({
  label,
  onBack,
  children,
}: {
  label: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <AriaButton
        onPress={onBack}
        className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-secondary max-sm:h-11 max-sm:text-md outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
      >
        <ChevronLeft aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
        {label}
      </AriaButton>
      <Separator />
      {children}
    </>
  );
}
