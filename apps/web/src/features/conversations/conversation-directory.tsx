import { Bookmark, Pin01 } from "@untitledui/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { Button } from "#src/components/base/buttons/button";
import { useAppToast } from "#src/components/ui/toast";
import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { ConversationRow } from "./conversation-row";
import {
  ChannelDirectoryRow,
  DirectDirectoryRow,
  type DirectoryChannel,
  type DirectoryRowMenu,
} from "./conversation-directory-rows";
import { useDirectoryLayout } from "./directory-layout";
import { DIRECTORY_INSET, DirectoryEmptyNote, DirectorySection } from "./directory-section-group";
import { useSavedEntries } from "./conversation-host";
import { conversationRowMenuEnabled } from "./conversation-row-menu-model";
import { useChatSections, useSidebarActions } from "./sidebar-lists";
import { ChatSectionDialog } from "./chat-section-dialog";
import { ChatSectionCreateMenu, ChatSectionMenu } from "./chat-section-menu";
import { directorySectionOrder, storedSectionOrder } from "./directory-section-order";
import type { ChatSection } from "./chat-section.schemas";
import type { ListedDirect } from "./sidebar-rows";
import {
  DirectoryDragOverlay,
  DirectoryDragRow,
  DirectoryDropList,
  DirectorySortableSection,
  useDirectoryDrag,
} from "./directory-drag";
import { channelRowKey, directRowKey } from "./pinned-conversations";
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

/** Channel and direct-message selection within the Chat page. */
export function ConversationDirectory({
  channels,
  agents,
  directRows: directRowList,
  viewerId,
  selectedChannelId,
  selectedDmId,
  selectedSaved,
}: {
  channels: DirectoryChannel[];
  agents: LiveAgent[];
  /** The viewer's DMs, with their Agents and with members, in the list's order: who each is with,
   * which are pinned (and in what order), and which are closed. */
  directRows: readonly ListedDirect[];
  /** The viewer, whose DM with themself reads "(you)". */
  viewerId?: string;
  selectedChannelId?: string;
  /** The open direct message, by conversation id (from the URL, so it highlights at once). */
  selectedDmId?: string;
  /** The Saved view is open — its sidebar entry renders as the current row. */
  selectedSaved?: boolean;
}) {
  const savedCount = useSavedEntries()?.length;
  const groups = useChatSections();
  const { sortedChannels, directRows, base, natural } = useDirectoryLayout({
    channels,
    agents,
    directRows: directRowList,
    viewerId,
    sections: groups.sections,
  });
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
  const sectionFailed = useCallback(
    (save: () => Promise<void>, sectionId?: string) => setSectionRetry({ save, sectionId }),
    [],
  );
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

  // Kept while the sections stand, so a row renders only for its own changes (`memo`).
  const sectionsReady = groups.status === "ready";
  const rowMenu = useMemo<DirectoryRowMenu>(
    () => ({ sections: groups.sections, sectionsReady, onSectionError: sectionFailed }),
    [groups.sections, sectionsReady, sectionFailed],
  );
  /** Every row by key, with whether it can be pinned (only a conversation the member is in). */
  const rows = new Map<string, { node: ReactNode; draggable: boolean; label: string }>([
    ...sortedChannels.map(
      (channel) =>
        [
          channelRowKey(channel.id),
          {
            node: (
              <ChannelDirectoryRow
                channel={channel}
                current={channel.id === selectedChannelId}
                menu={rowMenu}
              />
            ),
            draggable: conversationRowMenuEnabled(channel),
            label: channel.name,
          },
        ] as const,
    ),
    ...directRows.map(
      (row) =>
        [
          directRowKey(row.conversationId),
          {
            node: (
              <DirectDirectoryRow
                {...row}
                current={row.conversationId === selectedDmId}
                menu={rowMenu}
              />
            ),
            draggable: true,
            label: row.name,
          },
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
