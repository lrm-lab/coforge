import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, Maximize02 as Maximize, XClose as X } from "@untitledui/icons";
import { Input as AriaInput } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { edgeFadeStyle, TAB_BAR_END_FADE_WIDTH } from "#src/hooks/use-scroll-edges";
import { m } from "#src/paraglide/messages";
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

export function ReportTabsEditor({
  content,
  editable = true,
  editableTabs = false,
  placeholder,
  contentRevision = 0,
  trailingTabs,
  renderTrailingTab,
  onChange,
  onBlur,
  onUploadFile,
  onActiveTabChange,
  readingTurn,
}: {
  content: ReportContent;
  editable?: boolean;
  editableTabs?: boolean;
  placeholder: string;
  contentRevision?: number;
  trailingTabs?: readonly { id: string; label: string }[];
  renderTrailingTab?: (id: string) => ReactNode;
  onChange: (content: ReportContent) => void;
  onActiveTabChange?: (name: string) => void;
  onBlur?: () => void;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  readingTurn?: ReportTabsReadingTurn;
}) {
  const pages = content.tabs ?? { Summary: { markdown: content.markdown ?? "" } };
  const tabNames = content.tabs ? orderedReportTabNames(content) : Object.keys(pages);
  const trailing = trailingTabs ?? [];
  const allTabIds = [...tabNames, ...trailing.map((tab) => tab.id)];
  const [selectedTab, setSelectedTab] = useState(tabNames[0] ?? trailing[0]?.id ?? "");
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [presenting, setPresenting] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyScrollerRef = useRef<HTMLDivElement>(null);
  const contentEndRef = useRef<HTMLDivElement>(null);
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const activeTab = allTabIds.includes(selectedTab)
    ? selectedTab
    : (tabNames[0] ?? trailing[0]?.id ?? "");
  const trailingActive = trailing.some((tab) => tab.id === activeTab);

  useEffect(() => {
    if (activeTab) onActiveTabChange?.(activeTab);
  }, [activeTab, onActiveTabChange]);

  useEffect(() => {
    if (!allTabIds.includes(selectedTab)) setSelectedTab(tabNames[0] ?? trailing[0]?.id ?? "");
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
    setSelectedTab,
    bodyScrollerRef,
    contentEndRef,
  });

  function scrollTabs(direction: -1 | 1) {
    scrollerRef.current?.scrollBy({ left: direction * 160, behavior: "smooth" });
  }

  function defaultTabName() {
    const base = m.records_template_heading_level_one();
    if (!pages[base]) return base;
    let index = 2;
    while (pages[`${base} ${index}`]) index += 1;
    return `${base} ${index}`;
  }

  function emitOrderedTabs(entries: [string, ReportTab][]) {
    onChange({
      tabs: Object.fromEntries(entries),
      tabOrder: entries.map(([name]) => name),
    });
  }

  function addTab() {
    const name = defaultTabName();
    emitOrderedTabs([
      ...tabNames.map((tabName): [string, ReportTab] => [tabName, pages[tabName]!]),
      [name, { markdown: "" }],
    ]);
    setSelectedTab(name);
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
    emitOrderedTabs(
      tabNames.map((tabName): [string, ReportTab] => [
        tabName === original ? name : tabName,
        pages[tabName]!,
      ]),
    );
    if (activeTab === original) setSelectedTab(name);
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
    setSelectedTab(next);
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
    const entries = tabNames.map((tabName): [string, ReportTab] => [tabName, pages[tabName]!]);
    const sourceEntry = entries.find(([name]) => name === source);
    if (!sourceEntry) return;
    const remaining = entries.filter(([name]) => name !== source);
    remaining.splice(index, 0, sourceEntry);
    emitOrderedTabs(remaining);
  }

  function removeTab(name: string) {
    if (tabNames.length <= 1) return;
    const remaining = tabNames
      .filter((tabName) => tabName !== name)
      .map((tabName): [string, ReportTab] => [tabName, pages[tabName]!]);
    emitOrderedTabs(remaining);
    if (activeTab === name) {
      const nextName = remaining[0]?.[0] ?? "";
      setSelectedTab(nextName);
    }
  }

  function updateMarkdown(markdown: string) {
    if (!editable) return;
    const tab = pages[activeTab];
    if (!tab) return;
    emitOrderedTabs(
      tabNames.map((tabName): [string, ReportTab] => [
        tabName,
        tabName === activeTab ? { ...tab, markdown } : pages[tabName]!,
      ]),
    );
  }

  const activeContent = pages[activeTab]?.markdown ?? "";

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
          onFocus={() => setSelectedTab(name)}
          onKeyDown={(event) => onTabKeyDown(event, name)}
          onPressStart={press?.pressStart}
          onPress={() => {
            if (!press?.dragged()) setSelectedTab(name);
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
          className="pointer-events-none absolute -end-6 top-1 size-5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 any-pointer-coarse:pointer-events-auto any-pointer-coarse:static any-pointer-coarse:size-9 any-pointer-coarse:opacity-100"
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
              onFocus={() => setSelectedTab(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, tab.id)}
              onPress={() => setSelectedTab(tab.id)}
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
          onClick={() => setPresenting(true)}
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
                defaultValue={activeContent}
                placeholder={placeholder}
                className="report-sections min-h-[55vh]"
                editable={editable}
                onUploadFile={onUploadFile}
                onUpdate={updateMarkdown}
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
              defaultValue={activeContent}
              placeholder={placeholder}
              className="report-sections min-h-[55vh] pb-[45vh]"
              editable={editable}
              onUploadFile={onUploadFile}
              onUpdate={updateMarkdown}
              onBlur={onBlur}
            />
          </RecordsReadingColumn>
        </div>
      )}
      {presenting ? (
        <ReportPresentMode
          pages={tabNames.map((name) => ({ name, markdown: pages[name]?.markdown ?? "" }))}
          startIndex={Math.max(0, tabNames.indexOf(activeTab))}
          placeholder={placeholder ?? ""}
          onClose={(pageIndex) => {
            const name = tabNames[pageIndex];
            if (name) setSelectedTab(name);
            setPresenting(false);
          }}
        />
      ) : null}
    </div>
  );
}

function TabLabel({ name }: { name: string }) {
  return (
    <span className="inline-grid">
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-semibold">
        {name}
      </span>
      <span className="col-start-1 row-start-1">{name}</span>
    </span>
  );
}
