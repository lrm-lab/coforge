import { Bookmark, ChevronRight, Hash01 as Hash, Pin01, Plus } from "@untitledui/icons";
import { useEffect, useId, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Link as AriaLink } from "react-aria-components";

import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { useChannelUnreadCounts, useCloseConversationList } from "./conversation-navigation";
import { StartDirectMessagePopover } from "./start-direct-message-popover";
import { useSavedEntries } from "./conversation-host";
import { ConversationRowMenu } from "./conversation-row-menu";
import { conversationRowMenuEnabled } from "./conversation-row-menu-model";
import { useChatSections, useSidebarActions } from "./sidebar-lists";
import { ChatSectionDialog } from "./chat-section-dialog";
import { ChatSectionCreateMenu, ChatSectionMenu } from "./chat-section-menu";
import type { ChatSection } from "./chat-section.schemas";
import type { DirectRow } from "./sidebar-rows";
import {
  DirectoryDragOverlay,
  DirectoryDragRow,
  DirectoryDropList,
  DirectorySortableSection,
  useDirectoryDrag,
  type DirectoryDragActivation,
} from "./directory-drag";
import {
  channelRowKey,
  directRowKey,
  splitPinnedConversations,
  type DirectoryLayout,
} from "./pinned-conversations";
import { conversationRoute, type ConversationTarget } from "./last-conversation";
import {
  directorySectionHideable,
  readCollapsedSections,
  writeCollapsedSections,
  type CollapsibleSectionId,
  type DirectorySectionId,
} from "./directory-sections";
import { EMPTY_SECTION_HIDDEN_CLASS } from "#src/features/settings/hide-empty-sidebar-sections";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { getLocale } from "#src/paraglide/runtime";
import { lastMessageTime } from "./last-message-time";
import {
  channelMentionShown,
  channelPreviewLine,
  type ChannelPreviewSender,
} from "./channel-preview-line";
import { collageLayout } from "./collage-layout";
import { GroupAvatar, type GroupAvatarMember } from "./group-avatar";

type DirectoryChannel = {
  id: string;
  name: string;
  joined: boolean;
  /** The member muted this channel; its unread badge degrades to a bare dot. */
  muted?: boolean;
  /** The member pinned this row; it moves to the Pinned section and its menu item reads "Unpin". */
  pinned: boolean;
  /** Where the row sits in the Pinned section, among the member's pinned channels and DMs. */
  pinSortOrder: number | null;
  /** The channel's last message, or `null` while it has none (the row then shows its name only). */
  lastMessage: { createdAt: string; preview: string; sender: ChannelPreviewSender } | null;
  /** Up to six members, laid out by the row's collage avatar. */
  members: readonly GroupAvatarMember[];
  /** The viewer is @mentioned in this channel. */
  mentioned: boolean;
};

/** A DM row as the directory shows it: its row, the name it goes by, and its live Agent when it is
 * one with an Agent. */
type DirectEntry = DirectRow & { name: string; agent?: LiveAgent; self: boolean };

/** The row's accessible name: the conversation it names, plus its unread count when it has one,
 * and the mention when its "@" badge shows. A DM row's time and preview stay visible but are not
 * part of the name, so a read DM is named by `label` alone, as an unread one is. */
function rowLabel(
  unreadCount: number | undefined,
  label: string,
  mentioned: boolean | undefined,
): string | undefined {
  if (!unreadCount) return undefined;
  if (mentioned) return m.channel_unread_mention_accessible({ channel: label, count: unreadCount });
  return m.channel_unread_accessible({ channel: label, count: unreadCount });
}

/** A conversation row's second layout: the last message's time beside the name, and its sender-
 * prefixed preview under it, with the mention and unread markers at the end of that line. */
type LastMessageLines = {
  /** The clock or short date of the last message; `null` while the conversation has no message. */
  time: string | null;
  /** The preview line (`channelPreviewLine` for a channel); `null` while there is no message, so
   * the row shows the name only. */
  preview: string | null;
  /** The "@" badge shows: the viewer is mentioned and the mention is unread (`channelMentionShown`). */
  mentioned?: boolean;
};

/** The "@" marker of a row whose conversation mentions the viewer: a light-violet pill. */
function MentionBadge() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-primary px-1.5 text-xs font-semibold leading-none text-brand-secondary"
    >
      @
    </span>
  );
}

// A local row (not NavItemBase — its `icon` slot hardcodes size-5 and can't
// take an Avatar). The icon sets its own column width: a 44px avatar (a DM's avatar, or a channel's
// collage with one or more members) in a two-line row (`lastMessage` given), and a 20px icon for
// Saved and for a channel with no member. A two-line row has a second line with the
// last message's preview under its name. Both share the text start and the current/hover
// treatment. A channel's selected row is a card (`card`).
function ConversationRow({
  target,
  current,
  card,
  pinned,
  icon,
  muted,
  unreadCount,
  count,
  label,
  lastMessage,
  children,
}: {
  target: ConversationTarget;
  current?: boolean;
  /** The selected row is a bordered card, as a channel's is. */
  card?: boolean;
  /** The member pinned this row: its name draws the sidebar foreground colour (design spec),
   * darker than an unpinned row's, until it is selected or muted. */
  pinned?: boolean;
  icon: ReactNode;
  muted?: boolean;
  unreadCount?: number;
  /** A plain total shown at the row's end (the Saved entry's bookmark count), not an unread
   * signal: muted, and absent at zero. `label` is how the row's accessible name says it. */
  count?: { value: number; label: string };
  /** The row's own name, so an unread row keeps its accessible name instead of replacing it. */
  label: string;
  /** A two-line layout; absent for the Saved entry and every other single-line row. */
  lastMessage?: LastMessageLines;
  children: ReactNode;
}) {
  const closeList = useCloseConversationList();
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const route = conversationRoute(target, workspaceSlug);
  return (
    // The row is a React Aria link so the conversation menu's `MenuTrigger trigger="contextMenu"`
    // can use it as its trigger; `render` hands the element to TanStack's `Link`, which owns
    // navigation (React Aria's documented client-side routing pattern, react-aria.adobe.com/Link).
    <AriaLink
      href={router.buildLocation(route).href}
      // `href` is always set, so React Aria renders an `<a>`; the check narrows the props type.
      render={(props) => ("href" in props ? <Link {...props} {...route} /> : <span {...props} />)}
      aria-current={current ? "page" : undefined}
      aria-label={
        rowLabel(unreadCount, label, lastMessage?.mentioned) ??
        (count ? `${label}, ${count.label}` : lastMessage ? label : undefined)
      }
      // On mobile the list is a separate pane; choosing a row reveals the conversation even when
      // the URL is unchanged (re-opening the channel already in the address bar), which the
      // pathname-based reset in `ConversationNavigation` cannot see.
      onPress={closeList}
      className={cx(
        // `-webkit-user-drag: none`: a sidebar drag moves the row (see `directory-drag.tsx`), never
        // the browser's own link drag.
        "flex w-full cursor-pointer items-center gap-2 p-2 outline-focus-ring transition duration-100 ease-linear select-none [-webkit-user-drag:none] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2",
        card ? "rounded-xl border" : "rounded-md",
        !lastMessage && "max-h-9",
        current ? (card ? "bg-chat-selected-bg" : "bg-sidebar-accent") : "hover:bg-primary_hover",
        card && (current ? "border-chat-selected-border" : "border-transparent"),
      )}
    >
      {lastMessage ? (
        <span className="flex shrink-0 items-center justify-center">{icon}</span>
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      )}
      {lastMessage ? (
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cx(
                "min-w-0 flex-1 truncate text-sm font-medium",
                current
                  ? "text-brand-secondary"
                  : muted
                    ? "text-tertiary"
                    : pinned
                      ? "text-sidebar-fg"
                      : "text-secondary",
              )}
            >
              {children}
            </span>
            {lastMessage.time ? (
              <span className="shrink-0 text-xs text-quaternary tabular-nums">
                {lastMessage.time}
              </span>
            ) : null}
          </span>
          {lastMessage.preview || unreadCount || lastMessage.mentioned ? (
            <span className="flex min-w-0 items-center gap-2">
              {lastMessage.preview ? (
                <span className="min-w-0 flex-1 truncate text-sm text-tertiary">
                  {lastMessage.preview}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {lastMessage.mentioned ? <MentionBadge /> : null}
              {unreadCount ? muted ? <UnreadDot /> : <UnreadBadge count={unreadCount} /> : null}
            </span>
          ) : null}
        </span>
      ) : (
        <span
          className={cx(
            "min-w-0 flex-1 truncate text-sm font-semibold",
            current ? "text-brand-secondary" : muted ? "text-tertiary" : "text-secondary",
          )}
        >
          {children}
        </span>
      )}
      {!lastMessage && unreadCount ? (
        muted ? (
          <UnreadDot />
        ) : (
          <UnreadBadge count={unreadCount} />
        )
      ) : null}
      {count ? (
        <span aria-hidden="true" className="shrink-0 text-xs text-quaternary tabular-nums">
          {count.value}
        </span>
      ) : null}
    </AriaLink>
  );
}

/** Every row, title and list in the directory shares one inset, so a title's chevron, the Saved
 * entry's bookmark and a channel row's avatar all start on the same x: 0.75rem here plus the
 * 0.5rem a row pads itself by is the 1.25rem the design asks for. */
const DIRECTORY_INSET = "px-3";

/**
 * A sidebar group's title and its rows. A group that can collapse (Channels, Direct messages)
 * makes the whole caption its toggle, like Slack's sidebar sections, and draws a chevron in the
 * leading 20px gutter. A group that cannot (Pinned, per the design mockup) draws its own mark in
 * that same gutter instead, so every title in the list keeps the same x either way.
 */
function DirectorySection({
  label,
  icon: Icon,
  expanded,
  saving,
  onToggle,
  action,
  headingProps,
  children,
}: {
  label: string;
  /** A non-collapsible section's own mark, in the gutter a collapsible one gives its chevron —
   * the way the Saved entry carries a bookmark. Ignored on a collapsible section: the mockup
   * gives Channels and Direct messages a chevron and no second mark. */
  icon?: FC<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  expanded?: boolean;
  saving?: boolean;
  /** Absent on a section that cannot collapse: its rows are always shown, and its title row is
   * not a control at all, so it draws no chevron and takes no hover highlight. */
  onToggle?: () => void;
  /** Optional trailing control on the header row, e.g. a "+" that creates a channel. It sits
   * outside the toggle button so it is its own click target, not part of collapsing. */
  action?: ReactNode;
  headingProps?: DirectoryDragActivation;
  children: ReactNode;
}) {
  const listId = useId();
  // The title carries its own size, weight and colour, so it reads as a title of the list rather
  // than a caption above it (and beats the Button's own `font-semibold`, which belongs to a real
  // button).
  const title = (
    <span className="block truncate text-sm font-medium text-primary uppercase">{label}</span>
  );
  return (
    <>
      {/* One unified hover surface for the whole header row: the row itself carries the
          `hover:bg-primary_hover` (like a channel/DM row), and the toggle and the trailing `+`
          are transparent so they never paint a second, differently-shaped highlight. They stay
          independent click targets. `h-9` is the 2.25rem title row the list is built on: with no
          margin between the sections, consecutive titles land exactly 2.25rem apart. */}
      <div className={cx(DIRECTORY_INSET, "group/section")}>
        <div
          className={cx(
            "flex h-9 items-center gap-1 rounded-md pr-2 pl-2 transition-colors duration-100 ease-linear",
            onToggle && "group-hover/section:bg-primary_hover",
          )}
        >
          {onToggle ? (
            // The whole caption row is the toggle, and `flex-1` fills the row width, so the hit
            // area is large both ways (the user reported the old target was too small);
            // `justify-start pl-0` puts the chevron on the same x as a row's own icon.
            <Button
              {...headingProps}
              color="tertiary"
              size="sm"
              aria-expanded={expanded}
              aria-controls={listId}
              onPress={onToggle}
              isLoading={saving}
              isDisabled={saving}
              showTextWhileLoading
              className="min-w-0 flex-1 justify-start pr-2 pl-0 hover:bg-transparent! [&_[data-text]]:min-w-0 [&_[data-text]]:flex-1 [&_[data-text]]:text-left"
              iconLeading={
                <ChevronRight
                  aria-hidden="true"
                  className={cx(
                    "size-4 shrink-0 transition-transform duration-100 ease-linear",
                    expanded && "rotate-90",
                  )}
                />
              }
            >
              {title}
            </Button>
          ) : (
            // Nothing to press: the mark takes the chevron's gutter and the title keeps its x, so
            // this title line reads the same as the others without pretending to be a control.
            // `gap-1.5`, not the Button's own `gap-1`: the Button's label span adds 2px of its
            // own, so 6px here is what puts this title on the same x as a collapsible section's
            // (measured in the browser, both at 262px in the 1440 layout).
            <span className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
              {Icon ? (
                <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
              ) : null}
              {title}
            </span>
          )}
          {action}
        </div>
      </div>
      {/* Kept mounted but hidden: collapsing must not throw away the rows' realtime state. */}
      <div id={listId} hidden={onToggle ? !expanded : undefined}>
        {children}
      </div>
    </>
  );
}

/** Channel and direct-message selection within the Chat page. */
export function ConversationDirectory({
  channels,
  agents,
  directRows: directRowList,
  viewerId,
  selectedChannelId,
  selectedDmId,
  selectedSaved,
  onCreateChannel,
}: {
  channels: DirectoryChannel[];
  agents: LiveAgent[];
  /** The viewer's DMs, with their Agents and with members, in the list's order: who each is with,
   * which are pinned (and in what order), and which are closed. */
  directRows: readonly DirectRow[];
  /** The viewer, whose DM with themself reads "(you)". */
  viewerId?: string;
  selectedChannelId?: string;
  /** The open direct message, by conversation id (from the URL, so it highlights at once). */
  selectedDmId?: string;
  /** The Saved view is open — its sidebar entry renders as the current row. */
  selectedSaved?: boolean;
  /** Opens the create-channel flow from the "+" next to the CHANNELS caption. */
  onCreateChannel?: () => void;
}) {
  const unreadCounts = useChannelUnreadCounts();
  const savedCount = useSavedEntries()?.length;
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const timeContext = { now: new Date(), locale: getLocale(), timeZone, timeFormat };
  const groups = useChatSections();
  // Derived once per list change, not per render: the drag reads `base` and `natural` on every
  // pointer move.
  const { sortedChannels, directRows, base, natural } = useMemo(() => {
    const sortedChannels = [...channels].sort((left, right) =>
      left.joined === right.joined ? 0 : left.joined ? -1 : 1,
    );
    /** One row per existing DM (an Agent or member the viewer never wrote to has none), Agents and
     * members mixed in the list's order. A DM with an Agent that is gone is left out; a closed one
     * is left out of its section by the split. */
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const directRows = directRowList.flatMap((row): DirectEntry[] => {
      if (row.peer.kind === "people")
        return [{ ...row, name: row.peer.displayName, self: row.peer.userId === viewerId }];
      const agent = agentsById.get(row.peer.agentId);
      return agent ? [{ ...row, name: agent.displayName, agent, self: false }] : [];
    });
    const sections = splitPinnedConversations(sortedChannels, directRows);
    const base: DirectoryLayout = {
      pinned: sections.pinned.map((entry) =>
        entry.kind === "channel" ? channelRowKey(entry.id) : directRowKey(entry.id),
      ),
      channels: sections.channels.map((channel) => channelRowKey(channel.id)),
      agents: sections.directs.map((direct) => directRowKey(direct.conversationId)),
    };
    /** Where a row returns to when it is dragged out of Pinned: its list's own order. A closed DM
     * that is still pinned is included so it can be seen while it is dragged. */
    const natural = {
      channels: sortedChannels.map((channel) => channelRowKey(channel.id)),
      agents: directRows
        .filter((direct) => direct.pinned || !direct.hidden)
        .map((direct) => directRowKey(direct.conversationId)),
    };
    const keyById = new Map([
      ...sortedChannels.map((channel) => [channel.id, channelRowKey(channel.id)] as const),
      ...directRows.map(
        (direct) => [direct.conversationId, directRowKey(direct.conversationId)] as const,
      ),
    ]);
    const available = new Set([...base.channels, ...base.agents]);
    for (const group of groups.sections) {
      const keys = group.conversationIds.flatMap((id) => {
        const key = keyById.get(id);
        return key && available.has(key) ? [key] : [];
      });
      base[`custom:${group.id}`] = keys;
      const grouped = new Set(keys);
      base.channels = base.channels.filter((key) => !grouped.has(key));
      base.agents = base.agents.filter((key) => !grouped.has(key));
    }
    return { sortedChannels, directRows, base, natural };
  }, [channels, agents, directRowList, viewerId, groups.sections]);
  const toast = useAppToast();
  const actions = useSidebarActions();
  const [sectionRetry, setSectionRetry] = useState<{
    save: () => Promise<void>;
    sectionId?: string;
  } | null>(null);
  const pendingSectionIds = useRef(new Set<string>());
  const [savingSections, setSavingSections] = useState<ReadonlySet<string>>(new Set());
  const sectionFailed = (save: () => Promise<void>, sectionId?: string) =>
    setSectionRetry({ save, sectionId });
  const changeSection = (save: () => Promise<void>, sectionId?: string) => {
    if (sectionId && pendingSectionIds.current.has(sectionId)) return;
    if (sectionId) {
      pendingSectionIds.current.add(sectionId);
      setSavingSections(new Set(pendingSectionIds.current));
    }
    setSectionRetry(null);
    save()
      .catch(() => sectionFailed(save, sectionId))
      .finally(() => {
        if (sectionId) {
          pendingSectionIds.current.delete(sectionId);
          setSavingSections(new Set(pendingSectionIds.current));
        }
      });
  };
  const [editingSection, setEditingSection] = useState<ChatSection | "new" | null>(null);
  const [deletingSection, setDeletingSection] = useState<ChatSection | null>(null);
  const newSection = () => setEditingSection("new");
  const drag = useDirectoryDrag({
    layout: base,
    natural,
    sectionIds: groups.sections.map((section) => section.id),
    commitPins: (change) => {
      actions.arrange(change).catch((cause: unknown) => {
        console.error("pinned conversations could not be saved", cause);
        toast.error(m.conversation_menu_action_error());
      });
    },
    commitSection: ({ target, sectionId, beforeConversationId }) =>
      changeSection(
        () => actions.moveToSection(target, sectionId, beforeConversationId),
        sectionId ?? undefined,
      ),
    commitOrder: (ids) => changeSection(() => actions.reorderSections(ids), "section-order"),
  });
  /** All groups start expanded so SSR and the first client render agree; the stored preference
   * is applied right after mount (`localStorage` is unavailable during SSR). */
  const [collapsed, setCollapsed] = useState<CollapsibleSectionId[]>([]);
  useEffect(() => setCollapsed(readCollapsedSections()), []);
  const toggle = (id: CollapsibleSectionId) =>
    setCollapsed((current) => {
      const next = current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id];
      writeCollapsedSections(next);
      return next;
    });

  const channelRow = (channel: DirectoryChannel) => {
    const current = channel.id === selectedChannelId;
    return (
      <ConversationRowMenu
        target={{ kind: "channel", ...channel }}
        sections={groups.sections}
        sectionsReady={!groups.isPending && !groups.isError}
        onSectionError={sectionFailed}
      >
        <ConversationRow
          target={{ channelId: channel.id }}
          current={current}
          card
          pinned={channel.pinned}
          muted={!channel.joined || channel.muted}
          unreadCount={unreadCounts[channel.id]}
          label={`#${channel.name}`}
          lastMessage={{
            time: channel.lastMessage
              ? lastMessageTime(channel.lastMessage.createdAt, timeContext)
              : null,
            preview: channel.lastMessage
              ? channelPreviewLine({
                  sender: channel.lastMessage.sender,
                  preview: channel.lastMessage.preview,
                  youLabel: m.conversation_you(),
                })
              : null,
            mentioned: channelMentionShown({
              mentioned: channel.mentioned,
              unreadCount: unreadCounts[channel.id],
            }),
          }}
          icon={
            collageLayout(channel.members.length).length > 0 ? (
              <GroupAvatar members={channel.members} />
            ) : (
              <span className="flex size-5 items-center justify-center">
                <Hash
                  aria-hidden="true"
                  className={cx("size-4", current ? "text-brand-secondary" : "text-tertiary")}
                />
              </span>
            )
          }
        >
          {channel.name}
        </ConversationRow>
      </ConversationRowMenu>
    );
  };
  const directRow = ({
    conversationId,
    peer,
    pinned,
    name,
    agent,
    self,
    lastMessageAt,
    lastMessagePreview,
  }: DirectEntry) => (
    <ConversationRowMenu
      target={{ kind: "direct", conversationId, pinned }}
      sections={groups.sections}
      sectionsReady={!groups.isPending && !groups.isError}
      onSectionError={sectionFailed}
    >
      <ConversationRow
        target={{ dmId: conversationId }}
        current={conversationId === selectedDmId}
        pinned={pinned}
        unreadCount={unreadCounts[conversationId]}
        label={self ? m.conversation_dm_self_name({ name }) : name}
        lastMessage={{
          time: lastMessageAt ? lastMessageTime(lastMessageAt, timeContext) : null,
          preview: lastMessagePreview,
        }}
        icon={
          agent ? (
            <AgentDisplayAvatar
              name={agent.displayName}
              src={agent.avatarUrl}
              display={agent.display}
              size="sm"
              className="avatar-dm"
            />
          ) : peer.kind === "people" ? (
            <MemberAvatar
              size="sm"
              className="avatar-dm"
              userId={peer.userId}
              name={name}
              src={peer.avatarUrl}
            />
          ) : null
        }
      >
        {name}
        {self && <span className="text-quaternary">{m.conversation_dm_self_suffix()}</span>}
      </ConversationRow>
    </ConversationRowMenu>
  );
  /** Every row by key, with whether it can be pinned (only a conversation the member is in). */
  const rows = new Map<string, { node: ReactNode; draggable: boolean; label: string }>([
    ...sortedChannels.map(
      (channel) =>
        [
          channelRowKey(channel.id),
          {
            node: channelRow(channel),
            draggable: conversationRowMenuEnabled(channel),
            label: channel.name,
          },
        ] as const,
    ),
    ...directRows.map(
      (row) =>
        [
          directRowKey(row.conversationId),
          { node: directRow(row), draggable: true, label: row.name },
        ] as const,
    ),
  ]);
  const list = (section: DirectorySectionId) =>
    drag.layout[section].map((key) => {
      const row = rows.get(key);
      if (!row) return null;
      return (
        <DirectoryDragRow
          key={key}
          id={key}
          section={section}
          disabled={!row.draggable}
          label={row.label}
        >
          {row.node}
        </DirectoryDragRow>
      );
    });
  const pinnedEmpty = drag.layout.pinned.length === 0;

  return (
    <DndContext {...drag.context}>
      <div className={cx("mt-2", DIRECTORY_INSET)}>
        <ConversationRow
          target={{ view: "saved" }}
          current={selectedSaved}
          count={
            savedCount
              ? { value: savedCount, label: m.conversation_saved_count({ count: savedCount }) }
              : undefined
          }
          label={m.conversation_saved_nav()}
          icon={
            <Bookmark
              aria-hidden="true"
              className={cx("size-4", selectedSaved ? "text-brand-secondary" : "text-tertiary")}
            />
          }
        >
          {m.conversation_saved_nav()}
        </ConversationRow>
      </div>
      {groups.isError && (
        <div role="alert" className={cx(DIRECTORY_INSET, "py-2 text-sm text-error-primary")}>
          <p>{m.chat_section_load_error()}</p>
          <Button color="link-gray" size="sm" onPress={() => void groups.retry()}>
            {m.controls_retry()}
          </Button>
        </div>
      )}
      {sectionRetry && (
        <div role="alert" className={cx(DIRECTORY_INSET, "py-2 text-sm text-error-primary")}>
          <p>{m.chat_section_save_error()}</p>
          <Button
            color="link-gray"
            size="sm"
            onPress={() => changeSection(sectionRetry.save, sectionRetry.sectionId)}
          >
            {m.controls_retry()}
          </Button>
        </div>
      )}
      {/* Pinned channels and DMs, together and in the order they were pinned. Empty, it shows
          where to drop a row; a device without a mouse cannot drag, so it leaves it out there
          (its rows pin from their long-press menu), and so does Hide empty sidebar sections until
          a row is dragged. */}
      <div
        className={cx(
          pinnedEmpty && "hidden any-pointer-fine:block",
          directorySectionHideable({
            itemCount: base.pinned.length,
            dragging: drag.dragging,
            revealWhileDragging: true,
          }) && EMPTY_SECTION_HIDDEN_CLASS,
        )}
      >
        {/* Pinned does not collapse (design mockup): it is the list's drop target, and a member
            who pinned a handful of rows is saying those rows should stay in sight. Its pin takes
            the gutter the other sections give their chevron. */}
        <DirectorySection label={m.conversation_pinned_section()} icon={Pin01}>
          <div className={DIRECTORY_INSET}>
            <DirectoryDropList
              section="pinned"
              keys={drag.layout.pinned}
              label={m.conversation_pinned_section()}
            >
              {pinnedEmpty ? (
                <li className="flex min-h-9 items-center px-2 text-xs text-quaternary">
                  {m.conversation_pinned_empty_hint()}
                </li>
              ) : (
                list("pinned")
              )}
            </DirectoryDropList>
          </div>
        </DirectorySection>
      </div>
      <SortableContext
        items={groups.sections.map((section) => `group:${section.id}`)}
        strategy={verticalListSortingStrategy}
      >
        {groups.sections.map((section) => {
          const sectionId = `custom:${section.id}` as const;
          const keys = drag.layout[sectionId] ?? [];
          const label = `${section.emoji ? `${section.emoji} ` : ""}${section.name}`;
          return (
            <DirectorySortableSection
              key={section.id}
              id={section.id}
              label={label}
              disabled={savingSections.has(section.id) || savingSections.has("section-order")}
            >
              {(headingProps) => (
                <DirectorySection
                  label={label}
                  headingProps={headingProps}
                  expanded={
                    !drag.sortingSections &&
                    (!section.collapsed || drag.hoveredSection === sectionId)
                  }
                  saving={savingSections.has(section.id)}
                  onToggle={() =>
                    changeSection(
                      () => actions.updateSection(section.id, { collapsed: !section.collapsed }),
                      section.id,
                    )
                  }
                  action={
                    <ChatSectionMenu
                      section={section}
                      disabled={savingSections.has(section.id) || drag.dragging}
                      onEdit={() => setEditingSection(section)}
                      onDelete={() => setDeletingSection(section)}
                    />
                  }
                >
                  <div className={DIRECTORY_INSET}>
                    <DirectoryDropList section={sectionId} keys={keys} label={section.name}>
                      {keys.length > 0 ? (
                        list(sectionId)
                      ) : (
                        <li className="flex min-h-9 items-center px-2 text-xs text-quaternary">
                          {m.chat_section_empty()}
                        </li>
                      )}
                    </DirectoryDropList>
                  </div>
                </DirectorySection>
              )}
            </DirectorySortableSection>
          );
        })}
      </SortableContext>
      <div>
        <DirectorySection
          label={m.channels_title()}
          expanded={!collapsed.includes("channels")}
          onToggle={() => toggle("channels")}
          action={
            onCreateChannel ? (
              <ButtonUtility
                icon={Plus}
                size="xs"
                color="tertiary"
                tooltip={m.channel_create()}
                aria-label={m.channel_create()}
                onClick={onCreateChannel}
                className="shrink-0 hover:bg-transparent!"
              />
            ) : null
          }
        >
          <div className={DIRECTORY_INSET}>
            <DirectoryDropList
              section="channels"
              keys={drag.layout.channels}
              label={m.channels_title()}
            >
              {list("channels")}
            </DirectoryDropList>
          </div>
        </DirectorySection>
      </div>

      <div>
        <DirectorySection
          label={m.messages_agents_action()}
          expanded={!collapsed.includes("agents")}
          onToggle={() => toggle("agents")}
          action={<StartDirectMessagePopover />}
        >
          <div className={cx(DIRECTORY_INSET, "pb-3")}>
            <DirectoryDropList
              section="agents"
              keys={drag.layout.agents}
              label={m.messages_agents_action()}
            >
              {list("agents")}
            </DirectoryDropList>
          </div>
        </DirectorySection>
      </div>
      <ChatSectionCreateMenu
        onCreate={newSection}
        disabled={groups.isPending || groups.isError || drag.dragging}
      />
      {editingSection && (
        <ChatSectionDialog
          section={editingSection === "new" ? undefined : editingSection}
          onClose={() => setEditingSection(null)}
        />
      )}
      {deletingSection && (
        <ChatSectionDialog
          section={deletingSection}
          deleting
          onClose={() => setDeletingSection(null)}
        />
      )}
      <DirectoryDragOverlay active={drag.active}>
        {drag.active && !drag.active.group ? rows.get(drag.active.id)?.node : null}
      </DirectoryDragOverlay>
    </DndContext>
  );
}
