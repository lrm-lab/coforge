import { Pin01 } from "@untitledui/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { Button } from "#src/components/base/buttons/button";
import { useAppToast } from "#src/components/ui/toast";
import type { AgentDirectoryEntry } from "#src/features/agents/workspace-agents-realtime";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import {
  ChannelDirectoryRow,
  DirectDirectoryRow,
  type DirectoryChannel,
  type DirectoryRowMenu,
} from "./conversation-directory-rows";
import { useDirectoryLayout } from "./directory-layout";
import { DIRECTORY_INSET, DirectoryEmptyNote, DirectorySection } from "./directory-section-group";
import { SavedDirectoryRow } from "./saved-directory-row";
import { conversationRowMenuEnabled } from "./conversation-row-menu-model";
import { useChatSections, useSidebarActions } from "./sidebar-lists";
import { ChatSectionDialog } from "./chat-section-dialog";
import { ChatSectionCreateMenu, ChatSectionMenu, SectionSortMenu } from "./chat-section-menu";
import { directorySectionOrder, storedSectionOrder } from "./directory-section-order";
import {
  chatSectionSortModes,
  type ChatSection,
  type ChatSectionSortMode,
} from "./chat-section.schemas";
import type { ListedDirect } from "./sidebar-rows";
import {
  DirectoryDragOverlay,
  DirectoryDragRow,
  DirectoryDropList,
  DirectorySectionList,
  DirectorySortableSection,
  useDirectoryDrag,
} from "./directory-drag";
import { channelRowKey, directRowKey } from "./pinned-conversations";
import {
  directorySectionHideable,
  naturalSectionSortModes,
  readCollapsedSections,
  writeCollapsedSections,
  type CollapsibleSectionId,
  type DirectorySectionId,
} from "./directory-sections";
import { useBuiltInSectionSortModes } from "./use-built-in-section-sort";
import { DraftsDirectoryRow } from "./drafts-directory-row";
import {
  EMPTY_SECTION_HIDDEN_CLASS,
  readHideEmptySidebarSections,
  writeHideEmptySidebarSections,
} from "#src/features/settings/hide-empty-sidebar-sections";

export function ConversationDirectory({
  channels,
  agents,
  directRows: directRowList,
  viewerId,
  selectedChannelId,
  selectedDmId,
  selectedSaved,
  selectedDrafts,
}: {
  channels: DirectoryChannel[];
  agents: AgentDirectoryEntry[];
  directRows: readonly ListedDirect[];
  viewerId?: string;
  selectedChannelId?: string;
  selectedDmId?: string;
  selectedSaved?: boolean;
  selectedDrafts?: boolean;
}) {
  const groups = useChatSections();
  const { sortModes: builtInSortModes, setSortMode: changeBuiltInSortMode } =
    useBuiltInSectionSortModes();
  const { sortedChannels, directRows, base, natural } = useDirectoryLayout({
    channels,
    agents,
    directRows: directRowList,
    viewerId,
    sections: groups.sections,
    builtInSortModes,
  });
  const toast = useAppToast();
  const actions = useSidebarActions();
  const [sectionRetry, setSectionRetry] = useState<{
    save: () => Promise<void>;
    sectionId?: string;
  } | null>(null);
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
      if (
        builtInSortModes.pinned !== "manual" &&
        change.unpinned.length === 0 &&
        change.pins.length === base.pinned.length
      ) {
        changeBuiltInSortMode("pinned", "manual");
      }
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

  const sectionsReady = groups.status === "ready";
  const rowMenu = useMemo<DirectoryRowMenu>(
    () => ({ sections: groups.sections, sectionsReady, onSectionError: sectionFailed }),
    [groups.sections, sectionsReady, sectionFailed],
  );
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
    base[section].map((key) => {
      const row = rows.get(key);
      if (!row) return null;
      return (
        <DirectoryDragRow
          ripple={drag.ripple}
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
  const sortControl = <Mode extends ChatSectionSortMode>(
    count: number,
    name: string,
    mode: Mode,
    modes: readonly Mode[],
    onSort: (next: Mode) => void,
  ) =>
    count > 0 ? (
      <SectionSortMenu name={name} mode={mode} modes={modes} onSort={onSort} />
    ) : undefined;
  const pinnedEmpty = base.pinned.length === 0;

  return (
    <DndContext {...drag.context}>
      <div className={DIRECTORY_INSET}>
        <SavedDirectoryRow current={selectedSaved} />
        <DraftsDirectoryRow current={selectedDrafts} />
      </div>
      {groups.status === "failed" && (
        <div role="alert" className={cx(DIRECTORY_INSET, "py-2 text-sm text-error-primary")}>
          <p>{m.chat_section_load_error()}</p>
          <Button color="link-gray" size="sm" onPress={() => void groups.retry()}>
            {m.controls_retry()}
          </Button>
        </div>
      )}
      {sectionRetry && retryInSection === undefined && (
        <div className={DIRECTORY_INSET}>{sectionRetryNote}</div>
      )}
      <SortableContext
        items={sectionOrder.map((key) => `group:${key}`)}
        strategy={verticalListSortingStrategy}
      >
        <DirectorySectionList ripple={drag.ripple}>
          {sectionOrder.map((key) => {
            const reordering = savingSections.has("section-order") || !groups.orderReady;
            if (key === "pinned")
              return (
                <DirectorySortableSection
                  ripple={drag.ripple}
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
                    <DirectorySection
                      label={m.conversation_pinned_section()}
                      count={base.pinned.length}
                      empty={pinnedEmpty}
                      icon={Pin01}
                      headingProps={headingProps}
                      expanded={!drag.sortingSections && !collapsed.includes("pinned")}
                      onToggle={() => toggle("pinned")}
                      trailing={sortControl(
                        base.pinned.length,
                        m.conversation_pinned_section(),
                        builtInSortModes.pinned,
                        chatSectionSortModes,
                        (mode) => changeBuiltInSortMode("pinned", mode),
                      )}
                    >
                      <div className={DIRECTORY_INSET}>
                        <DirectoryDropList
                          ripple={drag.ripple}
                          section="pinned"
                          keys={base.pinned}
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
                  ripple={drag.ripple}
                  key={key}
                  id={key}
                  label={m.channels_title()}
                  disabled={reordering}
                >
                  {(headingProps) => (
                    <DirectorySection
                      label={m.channels_title()}
                      count={base.channels.length}
                      empty={base.channels.length === 0}
                      headingProps={headingProps}
                      expanded={!drag.sortingSections && !collapsed.includes("channels")}
                      onToggle={() => toggle("channels")}
                      trailing={sortControl(
                        base.channels.length,
                        m.channels_title(),
                        builtInSortModes.channels,
                        naturalSectionSortModes,
                        (mode) => changeBuiltInSortMode("channels", mode),
                      )}
                    >
                      <div className={DIRECTORY_INSET}>
                        <DirectoryDropList
                          ripple={drag.ripple}
                          section="channels"
                          keys={base.channels}
                          label={m.channels_title()}
                        >
                          {base.channels.length > 0 ? (
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
                  ripple={drag.ripple}
                  key={key}
                  id={key}
                  label={m.messages_agents_action()}
                  disabled={reordering}
                >
                  {(headingProps) => (
                    <DirectorySection
                      label={m.messages_agents_action()}
                      count={base.agents.length}
                      empty={base.agents.length === 0}
                      headingProps={headingProps}
                      expanded={!drag.sortingSections && !collapsed.includes("agents")}
                      onToggle={() => toggle("agents")}
                      trailing={sortControl(
                        base.agents.length,
                        m.messages_agents_action(),
                        builtInSortModes.agents,
                        naturalSectionSortModes,
                        (mode) => changeBuiltInSortMode("agents", mode),
                      )}
                    >
                      <div className={DIRECTORY_INSET}>
                        <DirectoryDropList
                          ripple={drag.ripple}
                          section="agents"
                          keys={base.agents}
                          label={m.messages_agents_action()}
                        >
                          {base.agents.length > 0 ? (
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
            const keys = base[key] ?? [];
            const label = `${section.emoji ? `${section.emoji} ` : ""}${section.name}`;
            const saving = savingSections.has(section.id);
            const sortSection = (sortMode: ChatSectionSortMode) =>
              changeSection(() => actions.updateSection(section.id, { sortMode }), section.id);
            return (
              <DirectorySortableSection
                ripple={drag.ripple}
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
                    trailing={sortControl(
                      keys.length,
                      section.name,
                      section.sortMode,
                      chatSectionSortModes,
                      sortSection,
                    )}
                    wrapTitle={(toggle) => (
                      <ChatSectionMenu
                        section={section}
                        hideEmpty={hideEmpty}
                        onSort={sortSection}
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
                      <DirectoryDropList
                        ripple={drag.ripple}
                        section={key}
                        keys={keys}
                        label={section.name}
                      >
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
        </DirectorySectionList>
      </SortableContext>
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
      <DirectoryDragOverlay ripple={drag.ripple} active={drag.active}>
        {drag.active && !drag.active.group ? rows.get(drag.active.id)?.node : null}
      </DirectoryDragOverlay>
    </DndContext>
  );
}
