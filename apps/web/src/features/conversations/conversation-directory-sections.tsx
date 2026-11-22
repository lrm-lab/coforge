import type { ReactNode } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { EMPTY_SECTION_HIDDEN_CLASS } from "#src/features/settings/hide-empty-sidebar-sections";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
  ChatSectionMenu,
  ChatSectionTouchMenu,
  SectionSortMenu,
  type ChatSectionMenuProps,
} from "./chat-section-menu";
import {
  chatSectionSortModes,
  type ChatSection,
  type ChatSectionSortMode,
} from "./chat-section.schemas";
import {
  DirectoryDropList,
  DirectorySectionList,
  DirectorySortableSection,
  type useDirectoryDrag,
} from "./directory-drag";
import { DIRECTORY_INSET, DirectoryEmptyNote, DirectorySection } from "./directory-section-group";
import {
  directorySectionHideable,
  naturalSectionSortModes,
  type BuiltInSectionId,
  type BuiltInSectionSortModes,
  type CollapsibleSectionId,
  type DirectorySectionId,
} from "./directory-sections";
import type { DirectoryLayout } from "./pinned-conversations";

type DirectoryDrag = ReturnType<typeof useDirectoryDrag>;

function sectionTrailing<Mode extends ChatSectionSortMode>(
  count: number,
  menuProps: ChatSectionMenuProps<Mode>,
) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 pointer-coarse:gap-1.5">
      {count > 0 && (
        <SectionSortMenu
          name={menuProps.name}
          mode={menuProps.sortMode}
          modes={menuProps.sortModes}
          onSort={menuProps.onSort}
        />
      )}
      <ChatSectionTouchMenu {...menuProps} />
    </span>
  );
}

export function ConversationDirectorySections({
  sectionOrder,
  sections,
  sectionsReady,
  orderReady,
  savingSections,
  base,
  drag,
  collapsed,
  builtInSortModes,
  hideEmpty,
  showJoinedOnly,
  retryInSection,
  sectionRetryNote,
  onToggleBuiltIn,
  onChangeBuiltInSortMode,
  onToggleCustomSection,
  onSortCustomSection,
  onCreateChannel,
  onShowJoinedOnlyChange,
  onHideEmptyChange,
  onEditSection,
  onCreateSection,
  onDeleteSection,
  renderList,
}: {
  sectionOrder: readonly DirectorySectionId[];
  sections: readonly ChatSection[];
  sectionsReady: boolean;
  orderReady: boolean;
  savingSections: ReadonlySet<string>;
  base: DirectoryLayout;
  drag: DirectoryDrag;
  collapsed: readonly CollapsibleSectionId[];
  builtInSortModes: BuiltInSectionSortModes;
  hideEmpty: boolean;
  showJoinedOnly: boolean;
  retryInSection?: string;
  sectionRetryNote: ReactNode;
  onToggleBuiltIn: (id: CollapsibleSectionId) => void;
  onChangeBuiltInSortMode: <Section extends BuiltInSectionId>(
    section: Section,
    mode: BuiltInSectionSortModes[Section],
  ) => void;
  onToggleCustomSection: (section: ChatSection) => void;
  onSortCustomSection: (section: ChatSection, sortMode: ChatSectionSortMode) => void;
  onCreateChannel?: () => void;
  onShowJoinedOnlyChange: (joinedOnly: boolean) => void;
  onHideEmptyChange: (hide: boolean) => void;
  onEditSection: (section: ChatSection) => void;
  onCreateSection: () => void;
  onDeleteSection: (section: ChatSection) => void;
  renderList: (section: DirectorySectionId) => ReactNode;
}) {
  const pinnedEmpty = base.pinned.length === 0;
  const reordering = savingSections.has("section-order") || !orderReady;

  return (
    <SortableContext
      items={sectionOrder.map((key) => `group:${key}`)}
      strategy={verticalListSortingStrategy}
    >
      <DirectorySectionList ripple={drag.ripple}>
        {sectionOrder.map((key) => {
          if (key === "pinned") {
            const pinnedMenu: ChatSectionMenuProps<ChatSectionSortMode> = {
              name: m.conversation_pinned_section(),
              sortMode: builtInSortModes.pinned,
              sortModes: chatSectionSortModes,
              hideEmpty,
              createDisabled: !sectionsReady,
              onSort: (mode) => onChangeBuiltInSortMode("pinned", mode),
              onHideEmptyChange,
              onCreate: onCreateSection,
            };
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
                    headingProps={headingProps}
                    expanded={!drag.sortingSections && !collapsed.includes("pinned")}
                    onToggle={() => onToggleBuiltIn("pinned")}
                    trailing={sectionTrailing(base.pinned.length, pinnedMenu)}
                    wrapTitle={(toggleButton) => (
                      <ChatSectionMenu {...pinnedMenu}>{toggleButton}</ChatSectionMenu>
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
                          renderList("pinned")
                        )}
                      </DirectoryDropList>
                    </div>
                  </DirectorySection>
                )}
              </DirectorySortableSection>
            );
          }
          if (key === "channels") {
            const channelsMenu = {
              name: m.channels_title(),
              sortMode: builtInSortModes.channels,
              sortModes: naturalSectionSortModes,
              hideEmpty,
              showJoinedOnly,
              createDisabled: !sectionsReady,
              onCreateChannel,
              onSort: (mode: BuiltInSectionSortModes["channels"]) =>
                onChangeBuiltInSortMode("channels", mode),
              onShowJoinedOnlyChange,
              onHideEmptyChange,
              onCreate: onCreateSection,
            };
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
                    onToggle={() => onToggleBuiltIn("channels")}
                    trailing={sectionTrailing(base.channels.length, channelsMenu)}
                    wrapTitle={(toggleButton) => (
                      <ChatSectionMenu {...channelsMenu}>{toggleButton}</ChatSectionMenu>
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
                          renderList("channels")
                        ) : (
                          <DirectoryEmptyNote>{m.chat_section_empty()}</DirectoryEmptyNote>
                        )}
                      </DirectoryDropList>
                    </div>
                  </DirectorySection>
                )}
              </DirectorySortableSection>
            );
          }
          if (key === "agents") {
            const agentsMenu = {
              name: m.messages_agents_action(),
              sortMode: builtInSortModes.agents,
              sortModes: naturalSectionSortModes,
              hideEmpty,
              createDisabled: !sectionsReady,
              onSort: (mode: BuiltInSectionSortModes["agents"]) =>
                onChangeBuiltInSortMode("agents", mode),
              onHideEmptyChange,
              onCreate: onCreateSection,
            };
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
                    onToggle={() => onToggleBuiltIn("agents")}
                    trailing={sectionTrailing(base.agents.length, agentsMenu)}
                    wrapTitle={(toggleButton) => (
                      <ChatSectionMenu {...agentsMenu}>{toggleButton}</ChatSectionMenu>
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
                          renderList("agents")
                        ) : (
                          <DirectoryEmptyNote>{m.chat_section_empty()}</DirectoryEmptyNote>
                        )}
                      </DirectoryDropList>
                    </div>
                  </DirectorySection>
                )}
              </DirectorySortableSection>
            );
          }
          const section = sections.find((entry) => `custom:${entry.id}` === key);
          if (!section) return null;
          const keys = base[key] ?? [];
          const accessibleLabel = `${section.emoji ? `${section.emoji} ` : ""}${section.name}`;
          const saving = savingSections.has(section.id);
          const sortSection = (sortMode: ChatSectionSortMode) =>
            onSortCustomSection(section, sortMode);
          const customMenu: ChatSectionMenuProps<ChatSectionSortMode> = {
            name: section.name,
            sortMode: section.sortMode,
            sortModes: chatSectionSortModes,
            hideEmpty,
            createDisabled: !sectionsReady,
            onSort: sortSection,
            onHideEmptyChange,
            onEdit: () => onEditSection(section),
            onCreate: onCreateSection,
            onDelete: () => onDeleteSection(section),
          };
          return (
            <DirectorySortableSection
              ripple={drag.ripple}
              key={key}
              id={key}
              label={accessibleLabel}
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
                  label={section.name}
                  leading={
                    section.emoji ? (
                      <span aria-hidden="true" className="shrink-0">
                        {section.emoji}
                      </span>
                    ) : undefined
                  }
                  count={keys.length}
                  empty={keys.length === 0}
                  headingProps={headingProps}
                  expanded={
                    !drag.sortingSections && (!section.collapsed || drag.hoveredSection === key)
                  }
                  onToggle={() => onToggleCustomSection(section)}
                  trailing={sectionTrailing(keys.length, customMenu)}
                  wrapTitle={(toggleButton) => (
                    <ChatSectionMenu {...customMenu}>{toggleButton}</ChatSectionMenu>
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
                        renderList(key)
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
  );
}
