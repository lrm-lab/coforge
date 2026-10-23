import { Bookmark, Hash01 as Hash, Pin01, Plus } from "@untitledui/icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { ConversationRow } from "./conversation-row";
import { DirectAgentAvatar } from "./direct-agent-avatar";
import { useChannelUnreadCounts } from "./conversation-navigation";
import { DIRECTORY_INSET, DirectoryEmptyNote, DirectorySection } from "./directory-section-group";
import { StartDirectMessagePopover } from "./start-direct-message-popover";
import { useSavedEntries } from "./conversation-host";
import { ConversationRowMenu } from "./conversation-row-menu";
import { conversationRowMenuEnabled } from "./conversation-row-menu-model";
import { useChatSections, useSidebarActions } from "./sidebar-lists";
import { ChatSectionDialog } from "./chat-section-dialog";
import { ChatSectionCreateMenu, ChatSectionMenu } from "./chat-section-menu";
import { sortSectionRows, type SortableRow } from "./chat-section-sort";
import { directorySectionOrder, storedSectionOrder } from "./directory-section-order";
import type { ChatSection } from "./chat-section.schemas";
import type { DirectRow } from "./sidebar-rows";
import {
  DirectoryDragOverlay,
  DirectoryDragRow,
  DirectoryDropList,
  DirectorySortableSection,
  useDirectoryDrag,
} from "./directory-drag";
import {
  channelRowKey,
  directRowKey,
  splitPinnedConversations,
  type DirectoryLayout,
} from "./pinned-conversations";
import {
  directorySectionHideable,
  readCollapsedSections,
  writeCollapsedSections,
  type CollapsibleSectionId,
  type DirectorySectionId,
} from "./directory-sections";
import {
  EMPTY_SECTION_HIDDEN_CLASS,
  readHideEmptySidebarSections,
  writeHideEmptySidebarSections,
} from "#src/features/settings/hide-empty-sidebar-sections";
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
  /** Up to six members: fetched so the group avatar can tell when to show "…" (it draws at most four). */
  members: readonly GroupAvatarMember[];
  /** The viewer is @mentioned in this channel. */
  mentioned: boolean;
};

/** A DM row as the directory shows it: its row, the name it goes by, and its live Agent when it is
 * one with an Agent. */
type DirectEntry = DirectRow & { name: string; agent?: LiveAgent; self: boolean };

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
    /** What a custom section's sort reads from each row. */
    const sortable = new Map<string, SortableRow>([
      ...sortedChannels.map((channel) => {
        const key = channelRowKey(channel.id);
        const row = {
          key,
          name: channel.name,
          lastMessageAt: channel.lastMessage?.createdAt ?? null,
        };
        return [key, row] as const;
      }),
      ...directRows.map((direct) => {
        const key = directRowKey(direct.conversationId);
        return [key, { key, name: direct.name, lastMessageAt: direct.lastMessageAt }] as const;
      }),
    ]);
    for (const group of groups.sections) {
      const rows = group.conversationIds.flatMap((id) => {
        const key = keyById.get(id);
        const row = key && available.has(key) ? sortable.get(key) : undefined;
        return row ? [row] : [];
      });
      const keys = sortSectionRows(rows, group.sortMode, getLocale());
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
  /** Saves under way per section (or `section-order`). A second change is not turned away while
   * one saves: a newer save takes over from an older one still waiting to be retried. */
  const pendingSaves = useRef(new Map<string, number>());
  const [savingSections, setSavingSections] = useState<ReadonlySet<string>>(new Set());
  const countSave = (sectionId: string, change: number) => {
    const count = (pendingSaves.current.get(sectionId) ?? 0) + change;
    if (count > 0) pendingSaves.current.set(sectionId, count);
    else pendingSaves.current.delete(sectionId);
    setSavingSections(new Set(pendingSaves.current.keys()));
  };
  const sectionFailed = (save: () => Promise<void>, sectionId?: string) =>
    setSectionRetry({ save, sectionId });
  const changeSection = (save: () => Promise<void>, sectionId?: string) => {
    if (sectionId) countSave(sectionId, +1);
    setSectionRetry(null);
    save()
      .catch(() => sectionFailed(save, sectionId))
      .finally(() => {
        if (sectionId) countSave(sectionId, -1);
      });
  };
  /** A section change that failed for good, under the section it was for: what happened and a
   * Retry, in the place the person was looking (§13, not a toast). */
  /** The open section a failed change shows under; none for the order or a folded section. */
  const retryInSection = groups.sections.find(
    (section) => section.id === sectionRetry?.sectionId && !section.collapsed,
  )?.id;
  const sectionRetryNote = sectionRetry && (
    <p
      role="alert"
      className="flex flex-wrap items-baseline gap-x-1 px-2 pb-1 text-xs text-error-primary"
    >
      {m.chat_section_change_failed()}
      <Button
        color="link-gray"
        size="sm"
        className="text-xs"
        onPress={() => changeSection(sectionRetry.save, sectionRetry.sectionId)}
      >
        {m.controls_retry()}
      </Button>
    </p>
  );
  const [editingSection, setEditingSection] = useState<ChatSection | "new" | null>(null);
  const [deletingSection, setDeletingSection] = useState<ChatSection | null>(null);
  const newSection = () => setEditingSection("new");
  const sectionOrder = useMemo(
    () =>
      directorySectionOrder(
        groups.order,
        groups.sections.map((section) => section.id),
      ),
    [groups.order, groups.sections],
  );
  const [hideEmpty, setHideEmpty] = useState(false);
  useEffect(() => setHideEmpty(readHideEmptySidebarSections()), []);
  const changeHideEmpty = (hide: boolean) => {
    writeHideEmptySidebarSections(hide);
    setHideEmpty(hide);
  };
  const drag = useDirectoryDrag({
    layout: base,
    natural,
    sectionIds: sectionOrder,
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
    commitOrder: (order) =>
      changeSection(() => actions.reorderSections(storedSectionOrder(order)), "section-order"),
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
        target={{ kind: "channel", ...channel, muted: channel.muted === true }}
        sections={groups.sections}
        sectionsReady={groups.status === "ready"}
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
    muted,
    name,
    agent,
    self,
    lastMessageAt,
    lastMessagePreview,
  }: DirectEntry) => (
    <ConversationRowMenu
      target={{ kind: "direct", conversationId, pinned, muted: muted === true }}
      sections={groups.sections}
      sectionsReady={groups.status === "ready"}
      onSectionError={sectionFailed}
    >
      <ConversationRow
        target={{ dmId: conversationId }}
        current={conversationId === selectedDmId}
        card
        pinned={pinned}
        muted={muted}
        unreadCount={unreadCounts[conversationId]}
        label={self ? m.conversation_dm_self_name({ name }) : name}
        lastMessage={{
          time: lastMessageAt ? lastMessageTime(lastMessageAt, timeContext) : null,
          preview: lastMessagePreview,
        }}
        icon={
          agent ? (
            <DirectAgentAvatar agent={agent} />
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
      {/* No top margin. The list pane's 0.75rem padding is the whole gap above
          this row, so the header rule lands 24px above the bookmark. */}
      <div className={DIRECTORY_INSET}>
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
              className={cx("size-4", selectedSaved ? "text-brand-secondary" : "text-primary")}
            />
          }
        >
          {m.conversation_saved_nav()}
        </ConversationRow>
      </div>
      {groups.status === "failed" && (
        <div role="alert" className={cx(DIRECTORY_INSET, "py-2 text-sm text-error-primary")}>
          <p>{m.chat_section_load_error()}</p>
          <Button color="link-gray" size="sm" onPress={() => void groups.retry()}>
            {m.controls_retry()}
          </Button>
        </div>
      )}
      {/* A change no open section shows (the sections' order, or a folded section's) says it
          failed above them all. */}
      {sectionRetry && retryInSection === undefined && (
        <div className={DIRECTORY_INSET}>{sectionRetryNote}</div>
      )}
      {/* Every section, in the member's order: each is dragged by its title row, and while one
          is dragged they all fold to their titles so the list is short enough to aim at. */}
      <SortableContext
        items={sectionOrder.map((key) => `group:${key}`)}
        strategy={verticalListSortingStrategy}
      >
        {sectionOrder.map((key) => {
          // Not while the order is being saved, nor before it is known.
          const reordering = savingSections.has("section-order") || !groups.orderReady;
          if (key === "pinned")
            return (
              // Pinned channels and DMs, together and in the order they were pinned. Empty, it
              // shows where to drop a row; a device without a mouse cannot drag, so it leaves it
              // out there (its rows pin from their long-press menu), and so does Hide empty
              // sidebar sections until a row is dragged.
              <DirectorySortableSection
                key={key}
                id={key}
                label={m.conversation_pinned_section()}
                disabled={reordering}
                className={cx(
                  pinnedEmpty && "hidden any-pointer-fine:block",
                  directorySectionHideable({
                    itemCount: base.pinned.length,
                    dragging: drag.dragging,
                    revealWhileDragging: true,
                  }) && EMPTY_SECTION_HIDDEN_CLASS,
                )}
              >
                {(headingProps) => (
                  // Pinned does not collapse (design mockup): it is the list's drop target, and a
                  // member who pinned a handful of rows is saying those rows should stay in
                  // sight. Its pin takes the gutter the other sections give their chevron.
                  <DirectorySection
                    label={m.conversation_pinned_section()}
                    count={drag.layout.pinned.length}
                    empty={pinnedEmpty}
                    icon={Pin01}
                    headingProps={headingProps}
                    expanded={drag.sortingSections ? false : undefined}
                  >
                    <div className={DIRECTORY_INSET}>
                      <DirectoryDropList
                        section="pinned"
                        keys={drag.layout.pinned}
                        label={m.conversation_pinned_section()}
                      >
                        {pinnedEmpty ? (
                          <DirectoryEmptyNote>
                            {m.conversation_pinned_empty_hint()}
                          </DirectoryEmptyNote>
                        ) : (
                          list("pinned")
                        )}
                      </DirectoryDropList>
                    </div>
                  </DirectorySection>
                )}
              </DirectorySortableSection>
            );
          if (key === "channels")
            return (
              <DirectorySortableSection
                key={key}
                id={key}
                label={m.channels_title()}
                disabled={reordering}
              >
                {(headingProps) => (
                  <DirectorySection
                    label={m.channels_title()}
                    count={drag.layout.channels.length}
                    empty={drag.layout.channels.length === 0}
                    headingProps={headingProps}
                    expanded={!drag.sortingSections && !collapsed.includes("channels")}
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
                        {drag.layout.channels.length > 0 ? (
                          list("channels")
                        ) : (
                          <DirectoryEmptyNote>{m.chat_section_empty()}</DirectoryEmptyNote>
                        )}
                      </DirectoryDropList>
                    </div>
                  </DirectorySection>
                )}
              </DirectorySortableSection>
            );
          if (key === "agents")
            return (
              <DirectorySortableSection
                key={key}
                id={key}
                label={m.messages_agents_action()}
                disabled={reordering}
              >
                {(headingProps) => (
                  <DirectorySection
                    label={m.messages_agents_action()}
                    count={drag.layout.agents.length}
                    empty={drag.layout.agents.length === 0}
                    headingProps={headingProps}
                    expanded={!drag.sortingSections && !collapsed.includes("agents")}
                    onToggle={() => toggle("agents")}
                    action={<StartDirectMessagePopover />}
                  >
                    <div className={DIRECTORY_INSET}>
                      <DirectoryDropList
                        section="agents"
                        keys={drag.layout.agents}
                        label={m.messages_agents_action()}
                      >
                        {drag.layout.agents.length > 0 ? (
                          list("agents")
                        ) : (
                          <DirectoryEmptyNote>{m.chat_section_empty()}</DirectoryEmptyNote>
                        )}
                      </DirectoryDropList>
                    </div>
                  </DirectorySection>
                )}
              </DirectorySortableSection>
            );
          const section = groups.sections.find((entry) => `custom:${entry.id}` === key);
          if (!section) return null;
          const keys = drag.layout[key] ?? [];
          const label = `${section.emoji ? `${section.emoji} ` : ""}${section.name}`;
          const saving = savingSections.has(section.id);
          return (
            <DirectorySortableSection
              key={key}
              id={key}
              label={label}
              disabled={saving || reordering}
              className={
                directorySectionHideable({
                  itemCount: base[key]?.length ?? 0,
                  dragging: drag.dragging,
                  revealWhileDragging: true,
                })
                  ? EMPTY_SECTION_HIDDEN_CLASS
                  : undefined
              }
            >
              {(headingProps) => (
                <DirectorySection
                  label={label}
                  count={keys.length}
                  empty={keys.length === 0}
                  headingProps={headingProps}
                  expanded={
                    !drag.sortingSections && (!section.collapsed || drag.hoveredSection === key)
                  }
                  onToggle={() =>
                    changeSection(
                      () => actions.updateSection(section.id, { collapsed: !section.collapsed }),
                      section.id,
                    )
                  }
                  wrapTitle={(toggle) => (
                    <ChatSectionMenu
                      section={section}
                      hideEmpty={hideEmpty}
                      onSort={(sortMode) =>
                        changeSection(
                          () => actions.updateSection(section.id, { sortMode }),
                          section.id,
                        )
                      }
                      onHideEmptyChange={changeHideEmpty}
                      onEdit={() => setEditingSection(section)}
                      onCreate={newSection}
                      onDelete={() => setDeletingSection(section)}
                    >
                      {toggle}
                    </ChatSectionMenu>
                  )}
                >
                  <div className={DIRECTORY_INSET}>
                    {retryInSection === section.id && sectionRetryNote}
                    <DirectoryDropList section={key} keys={keys} label={section.name}>
                      {keys.length > 0 ? (
                        list(key)
                      ) : (
                        <DirectoryEmptyNote>{m.chat_section_empty()}</DirectoryEmptyNote>
                      )}
                    </DirectoryDropList>
                  </div>
                </DirectorySection>
              )}
            </DirectorySortableSection>
          );
        })}
      </SortableContext>
      {/* Room under the last section; also the blank space whose context menu creates one. */}
      <div className="pb-3" />
      <ChatSectionCreateMenu
        onCreate={newSection}
        disabled={groups.status !== "ready" || drag.dragging}
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
