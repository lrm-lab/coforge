import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronLeft, ChevronRight, Maximize02 as Maximize, XClose as X } from "@untitledui/icons";
import { Input as AriaInput } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { edgeFadeStyle, TAB_BAR_END_FADE_WIDTH } from "#src/hooks/use-scroll-edges";
import { m } from "#src/paraglide/messages";
import type { ContentEditorRef } from "#src/features/records/report-editor/content-editor";
import { ReportSectionEditor } from "#src/features/records/report-editor/report-section-editor";
import { orderedReportTabNames, type ReportContent, type ReportTab } from "./records-content";
import { cn } from "#src/lib/utils";
import type { UploadResult } from "#src/features/records/report-editor/types";
import { ReportPresentMode } from "./report-present-mode";
import { ReportTabDrag, ReportTabDragItem, type ReportTabPress } from "./report-tab-drag";
import { nextReportTabIdFromKey } from "./report-tab-keyboard";
import { RecordsReadingColumn } from "./records-reading-column";
import {
  useReportTabsReadingTurn,
  type ReportTabsReadingTurn,
} from "./use-report-tabs-reading-turn";

export type ReportTabsEditorRef = {
  flush: () => void;
  markClean: () => void;
};

export type ReportTabsChangeMeta = {
  structural?: boolean;
};

export function ReportTabsEditor({
  content,
  editable = true,
  editableTabs = false,
  placeholder,
  contentRevision = 0,
  trailingTabs,
  renderTrailingTab,
  onChange,
  onDirty,
  onBlur,
  onUploadFile,
  onActiveTabChange,
  readingTurn,
  editorRef,
}: {
  content: ReportContent;
  editable?: boolean;
  editableTabs?: boolean;
  placeholder: string;
  contentRevision?: number;
  trailingTabs?: readonly { id: string; label: string }[];
  renderTrailingTab?: (id: string) => ReactNode;
  onChange: (content: ReportContent, meta?: ReportTabsChangeMeta) => void;
  onDirty?: () => void;
  onActiveTabChange?: (name: string) => void;
  onBlur?: () => void;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  readingTurn?: ReportTabsReadingTurn;
  editorRef?: Ref<ReportTabsEditorRef>;
}) {
  const pages = content.tabs ?? { Summary: { markdown: content.markdown ?? "" } };
  const tabNames = content.tabs ? orderedReportTabNames(content) : Object.keys(pages);
  const trailing = trailingTabs ?? [];
  const allTabIds = [...tabNames, ...trailing.map((tab) => tab.id)];
  const defaultTab = tabNames[0] ?? trailing[0]?.id ?? "";
  const [selectedTab, setSelectedTab] = useState(defaultTab);
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [presentPages, setPresentPages] = useState<ReadonlyArray<{
    name: string;
    markdown: string;
  }> | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyScrollerRef = useRef<HTMLDivElement>(null);
  const contentEndRef = useRef<HTMLDivElement>(null);
  const sectionEditorRef = useRef<ContentEditorRef>(null);
  const livePagesRef = useRef<Record<string, ReportTab>>({ ...pages });
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const activeTab = allTabIds.includes(selectedTab) ? selectedTab : defaultTab;
  const trailingActive = trailing.some((tab) => tab.id === activeTab);

  const [syncedContent, setSyncedContent] = useState(() => ({
    content,
    contentRevision,
    activeMarkdown: pages[defaultTab]?.markdown ?? "",
  }));
  if (syncedContent.content !== content || syncedContent.contentRevision !== contentRevision) {
    setSyncedContent({
      content,
      contentRevision,
      activeMarkdown: pages[activeTab]?.markdown ?? "",
    });
  }

  useLayoutEffect(() => {
    livePagesRef.current = { ...pages };
  }, [content, contentRevision]);

  useImperativeHandle(
    editorRef,
    () => ({
      flush: () => {
        sectionEditorRef.current?.flush();
      },
      markClean: () => {
        sectionEditorRef.current?.markClean();
      },
    }),
    [],
  );

  const selectTab = useLatestCallback((nextTab: string) => {
    if (nextTab === activeTab) return;
    sectionEditorRef.current?.flush();
    setSelectedTab(nextTab);
    setSyncedContent((prev) => ({
      ...prev,
      activeMarkdown: livePagesRef.current[nextTab]?.markdown ?? pages[nextTab]?.markdown ?? "",
    }));
  });

  useEffect(() => {
    if (activeTab) onActiveTabChange?.(activeTab);
  }, [activeTab, onActiveTabChange]);

  useEffect(() => {
    if (!allTabIds.includes(selectedTab)) {
      setSelectedTab(defaultTab);
      setSyncedContent((prev) => ({
        ...prev,
        activeMarkdown:
          livePagesRef.current[defaultTab]?.markdown ?? pages[defaultTab]?.markdown ?? "",
      }));
    }
  }, [selectedTab, allTabIds.join("\u0000")]);

  function updateTabOverflow() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setTabOverflow({
      left: scroller.scrollLeft > 4,
      right: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4,
    });
  }

  useLayoutEffect(() => {
    updateTabOverflow();
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => updateTabOverflow());
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [tabNames.join("\u0000"), trailing.map((tab) => tab.id).join("\u0000")]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !activeTab) return;
    const selected = scroller.querySelector('[data-selected="true"]');
    if (!(selected instanceof HTMLElement)) return;
    selected.scrollIntoView({ inline: "nearest", block: "nearest" });
    updateTabOverflow();
  }, [activeTab]);

  useReportTabsReadingTurn({
    readingTurn,
    allTabIds,
    activeTab,
    setSelectedTab: selectTab,
    bodyScrollerRef,
    contentEndRef,
  });

  function scrollTabs(direction: -1 | 1) {
    scrollerRef.current?.scrollBy({ left: direction * 160, behavior: "smooth" });
  }

  function currentPage(name: string): ReportTab {
    return livePagesRef.current[name] ?? pages[name] ?? { markdown: "" };
  }

  function defaultTabName() {
    const base = m.records_template_heading_level_one();
    if (!pages[base]) return base;
    let index = 2;
    while (pages[`${base} ${index}`]) index += 1;
    return `${base} ${index}`;
  }

  function emitOrderedTabs(entries: [string, ReportTab][], structural = false) {
    onChange(
      {
        tabs: Object.fromEntries(entries),
        tabOrder: entries.map(([name]) => name),
      },
      structural ? { structural: true } : undefined,
    );
  }

  function addTab() {
    sectionEditorRef.current?.flush();
    const name = defaultTabName();
    emitOrderedTabs(
      [
        ...tabNames.map((tabName): [string, ReportTab] => [tabName, currentPage(tabName)]),
        [name, { markdown: "" }],
      ],
      true,
    );
    setSelectedTab(name);
    setSyncedContent((prev) => ({ ...prev, activeMarkdown: "" }));
    setEditingTab(name);
    setEditingName("");
  }

  function startEditingTab(name: string) {
    if (!editableTabs) return;
    setEditingTab(name);
    setEditingName(name);
  }

  function commitEditingTab() {
    if (!editingTab) return;
    const name = editingName.trim();
    const original = editingTab;
    setEditingTab(null);
    if (!name || name === original || pages[name]) return;
    sectionEditorRef.current?.flush();
    emitOrderedTabs(
      tabNames.map((tabName): [string, ReportTab] => [
        tabName === original ? name : tabName,
        currentPage(tabName),
      ]),
      true,
    );
    if (activeTab === original) {
      setSelectedTab(name);
      setSyncedContent((prev) => ({
        ...prev,
        activeMarkdown: currentPage(original).markdown,
      }));
    }
  }

  function handleEditChange(event: ChangeEvent<HTMLInputElement>) {
    setEditingName(event.target.value);
  }

  function focusReportTab(id: string) {
    const node = scrollerRef.current?.querySelector(`[data-report-tab="${CSS.escape(id)}"]`);
    if (node instanceof HTMLElement) node.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const next = nextReportTabIdFromKey(allTabIds, id, event.key, event.shiftKey);
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    focusReportTab(next);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitEditingTab();
    }
    if (event.key === "Escape") setEditingTab(null);
  }

  function moveTab(source: string, index: number) {
    sectionEditorRef.current?.flush();
    const entries = tabNames.map((tabName): [string, ReportTab] => [tabName, currentPage(tabName)]);
    const sourceEntry = entries.find(([name]) => name === source);
    if (!sourceEntry) return;
    const remaining = entries.filter(([name]) => name !== source);
    remaining.splice(index, 0, sourceEntry);
    emitOrderedTabs(remaining, true);
  }

  function removeTab(name: string) {
    if (tabNames.length <= 1) return;
    sectionEditorRef.current?.flush();
    const remaining = tabNames
      .filter((tabName) => tabName !== name)
      .map((tabName): [string, ReportTab] => [tabName, currentPage(tabName)]);
    emitOrderedTabs(remaining, true);
    if (activeTab === name) {
      const nextName = remaining[0]?.[0] ?? "";
      setSelectedTab(nextName);
      setSyncedContent((prev) => ({
        ...prev,
        activeMarkdown: remaining[0]?.[1].markdown ?? "",
      }));
    }
  }

  function updateMarkdown(markdown: string) {
    if (!editable) return;
    const tab = livePagesRef.current[activeTab] ?? pages[activeTab];
    if (!tab) return;
    const updatedTab: ReportTab = { ...tab, markdown };
    livePagesRef.current = { ...livePagesRef.current, [activeTab]: updatedTab };
    emitOrderedTabs(
      tabNames.map((tabName): [string, ReportTab] => [
        tabName,
        tabName === activeTab ? updatedTab : currentPage(tabName),
      ]),
    );
  }

  function openPresentMode() {
    sectionEditorRef.current?.flush();
    setPresentPages(tabNames.map((name) => ({ name, markdown: currentPage(name).markdown })));
  }

  const activeContent = syncedContent.activeMarkdown;

  const tabButtonClass = (active: boolean) =>
    cn(
      "rounded-none px-1 pb-2.5 pt-1 text-sm hover:*:data-text:decoration-transparent any-pointer-coarse:min-h-11 any-pointer-coarse:px-2",
      active
        ? "border-b-2 border-brand-solid font-semibold text-primary"
        : "border-b-2 border-transparent font-medium text-tertiary hover:text-secondary hover:*:data-text:font-semibold",
    );

  const chevronClass =
    "mb-2 size-6 shrink-0 p-1 text-fg-quaternary *:data-icon:rtl:rotate-180 any-pointer-coarse:mb-0 any-pointer-coarse:size-11";

  const renderTab = (name: string, press?: ReportTabPress) => (
    <>
      {editingTab === name ? (
        <AriaInput
          autoFocus
          maxLength={200}
          value={editingName}
          aria-label={`${m.records_template_dimension()}: ${name}`}
          onChange={handleEditChange}
          onBlur={commitEditingTab}
          onKeyDown={handleEditKeyDown}
          className="w-28 min-w-0 rounded-none border-b-2 border-brand-solid bg-transparent px-1 pb-2.5 pt-1 text-sm font-semibold text-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring any-pointer-coarse:min-h-11"
        />
      ) : (
        <Button
          type="button"
          size="sm"
          color="link-gray"
          data-report-tab={name}
          data-selected={name === activeTab ? "true" : undefined}
          aria-selected={name === activeTab}
          onFocus={() => selectTab(name)}
          onKeyDown={(event) => onTabKeyDown(event, name)}
          onPressStart={press?.pressStart}
          onPress={() => {
            if (!press?.dragged()) selectTab(name);
          }}
          onDoubleClick={() => startEditingTab(name)}
          className={tabButtonClass(name === activeTab)}
        >
          <TabLabel name={name} />
        </Button>
      )}
      {editableTabs ? (
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={X}
          aria-label={`${m.records_template_delete()}: ${name}`}
          isDisabled={tabNames.length <= 1}
          onClick={() => removeTab(name)}
          className="pointer-events-none absolute -end-6 top-1 size-5 opacity-0 transition-opacity duration-(--duration-label-out) ease-in before:pointer-events-auto before:absolute before:inset-y-0 before:-inset-s-2 before:w-2 before:content-[''] group-hover:pointer-events-auto group-hover:opacity-100 group-hover:duration-(--duration-label-in) group-hover:ease-out group-focus-within:pointer-events-auto group-focus-within:opacity-100 any-pointer-coarse:pointer-events-auto any-pointer-coarse:static any-pointer-coarse:size-9 any-pointer-coarse:opacity-100"
        />
      ) : null}
    </>
  );

  const tabBar = (
    <>
      {tabOverflow.left ? (
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={ChevronLeft}
          aria-label={m.records_format_tab_scroll_prev()}
          onClick={() => scrollTabs(-1)}
          className={chevronClass}
        />
      ) : null}
      <nav
        ref={scrollerRef}
        aria-label={m.records_template_dimension()}
        onScroll={updateTabOverflow}
        style={edgeFadeStyle(
          { start: false, end: tabOverflow.right },
          { end: TAB_BAR_END_FADE_WIDTH },
        )}
        className="scrollbar-hide flex min-w-0 flex-1 items-center gap-8 overflow-x-auto overflow-y-hidden overscroll-x-contain pt-0 scroll-pe-14 sm:gap-10"
      >
        {editableTabs ? (
          <ReportTabDrag order={tabNames} onMove={moveTab} className="gap-8 pe-6 sm:gap-10">
            {tabNames.map((name) => (
              <ReportTabDragItem
                key={name}
                name={name}
                disabled={editingTab === name}
                className="group relative flex shrink-0 items-center gap-0.5"
              >
                {(press) => renderTab(name, press)}
              </ReportTabDragItem>
            ))}
          </ReportTabDrag>
        ) : (
          tabNames.map((name) => (
            <div key={name} className="group flex shrink-0 items-center gap-0.5">
              {renderTab(name)}
            </div>
          ))
        )}
        {trailing.map((tab) => (
          <div key={tab.id} className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              size="sm"
              color="link-gray"
              data-report-tab={tab.id}
              data-selected={tab.id === activeTab ? "true" : undefined}
              aria-selected={tab.id === activeTab}
              onFocus={() => selectTab(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, tab.id)}
              onPress={() => selectTab(tab.id)}
              className={tabButtonClass(tab.id === activeTab)}
            >
              {tab.label}
            </Button>
          </div>
        ))}
      </nav>
      {tabOverflow.right ? (
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={ChevronRight}
          aria-label={m.records_format_tab_scroll_next()}
          onClick={() => scrollTabs(1)}
          className={chevronClass}
        />
      ) : null}
      {editableTabs ? (
        <Button
          type="button"
          size="sm"
          color="link-color"
          onPress={addTab}
          className="mb-2 shrink-0 px-1 any-pointer-coarse:mb-0 any-pointer-coarse:min-h-11 any-pointer-coarse:px-2.5"
        >
          {m.records_template_add_heading_level_one()}
        </Button>
      ) : null}
      {tabNames.length > 0 ? (
        <ButtonUtility
          size="xs"
          color="tertiary"
          icon={Maximize}
          aria-label={m.records_report_present()}
          onClick={openPresentMode}
          className="mb-2 size-6 shrink-0 p-1 text-fg-quaternary any-pointer-coarse:mb-0 any-pointer-coarse:size-11"
        />
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0">
        <RecordsReadingColumn className="pb-0 pt-2">
          <div className="flex items-end gap-1 border-b border-secondary/40">{tabBar}</div>
        </RecordsReadingColumn>
      </div>

      {readingTurn ? (
        <div ref={bodyScrollerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          {trailingActive ? (
            (renderTrailingTab?.(activeTab) ?? null)
          ) : (
            <RecordsReadingColumn className="pt-5">
              <ReportSectionEditor
                key={`${activeTab}:${contentRevision}`}
                editorRef={sectionEditorRef}
                defaultValue={activeContent}
                placeholder={placeholder}
                className="report-sections min-h-[55vh]"
                editable={editable}
                onUploadFile={onUploadFile}
                onUpdate={updateMarkdown}
                onDirty={onDirty}
                onBlur={onBlur}
              />
            </RecordsReadingColumn>
          )}
          <div ref={contentEndRef} className="h-px" aria-hidden="true" />
        </div>
      ) : trailingActive ? (
        (renderTrailingTab?.(activeTab) ?? null)
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RecordsReadingColumn className="pt-5">
            <ReportSectionEditor
              key={`${activeTab}:${contentRevision}`}
              editorRef={sectionEditorRef}
              defaultValue={activeContent}
              placeholder={placeholder}
              className="report-sections min-h-[55vh] pb-[45vh]"
              editable={editable}
              onUploadFile={onUploadFile}
              onUpdate={updateMarkdown}
              onDirty={onDirty}
              onBlur={onBlur}
            />
          </RecordsReadingColumn>
        </div>
      )}
      {presentPages ? (
        <ReportPresentMode
          pages={presentPages}
          startIndex={Math.max(0, tabNames.indexOf(activeTab))}
          placeholder={placeholder ?? ""}
          onClose={(pageIndex) => {
            const name = tabNames[pageIndex];
            if (name) selectTab(name);
            setPresentPages(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TabLabel({ name }: { name: string }) {
  return (
    <span className="inline-grid max-w-48">
      <span
        aria-hidden="true"
        dir="auto"
        className="invisible col-start-1 row-start-1 max-w-full truncate font-semibold"
      >
        {name}
      </span>
      <span dir="auto" className="col-start-1 row-start-1 max-w-full truncate">
        {name}
      </span>
    </span>
  );
}
