import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";

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
import { ConversationDirectorySections } from "./conversation-directory-sections";
import { useDirectoryLayout } from "./directory-layout";
import { DIRECTORY_INSET } from "./directory-section-group";
import { SavedDirectoryRow } from "./saved-directory-row";
import { conversationRowMenuEnabled } from "./conversation-row-menu-model";
import { useChatSections, useSidebarActions } from "./sidebar-lists";
import { ChatSectionDialog } from "./chat-section-dialog";
import { ChatSectionCreateMenu } from "./chat-section-menu";
import { directorySectionOrder, storedSectionOrder } from "./directory-section-order";
import type { ChatSection } from "./chat-section.schemas";
import type { ListedDirect } from "./sidebar-rows";
import { DirectoryDragOverlay, DirectoryDragRow, useDirectoryDrag } from "./directory-drag";
import { channelRowKey, directRowKey } from "./pinned-conversations";
import {
  readCollapsedSections,
  writeCollapsedSections,
  type CollapsibleSectionId,
  type DirectorySectionId,
} from "./directory-sections";
import { useBuiltInSectionSortModes } from "./use-built-in-section-sort";
import { DraftsDirectoryRow } from "./drafts-directory-row";
import {
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
      <ConversationDirectorySections
        sectionOrder={sectionOrder}
        sections={groups.sections}
        orderReady={groups.orderReady}
        savingSections={savingSections}
        base={base}
        drag={drag}
        collapsed={collapsed}
        builtInSortModes={builtInSortModes}
        hideEmpty={hideEmpty}
        retryInSection={retryInSection}
        sectionRetryNote={sectionRetryNote}
        onToggleBuiltIn={toggle}
        onChangeBuiltInSortMode={changeBuiltInSortMode}
        onToggleCustomSection={(section) =>
          changeSection(
            () => actions.updateSection(section.id, { collapsed: !section.collapsed }),
            section.id,
          )
        }
        onSortCustomSection={(section, sortMode) =>
          changeSection(() => actions.updateSection(section.id, { sortMode }), section.id)
        }
        onHideEmptyChange={changeHideEmpty}
        onEditSection={setEditingSection}
        onCreateSection={newSection}
        onDeleteSection={setDeletingSection}
        renderList={list}
      />
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
