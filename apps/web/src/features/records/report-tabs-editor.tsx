import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, Maximize02 as Maximize, XClose as X } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { LeaderFormatSectionsEditor } from "./leader-format-sections-editor";
import { ReportSectionEditor } from "#src/features/records/report-editor/report-section-editor";
import type { ReportContent } from "./records-content";
import { cn } from "#src/lib/utils";
import type { UploadResult } from "#src/features/records/report-editor/types";
import { isReportImageZoomOpen } from "./report-image-zoom";
import { ReportPresentMode } from "./report-present-mode";
import { RecordsReadingColumn } from "./records-reading-column";
import {
  clearReadingEdge,
  contentEdgeReached,
  noteReadingWheel,
  readReadingEdge,
  readingWheelPixels,
  stepMemberReportPage,
  type ReadingEdge,
  type ReadingWheelGesture,
} from "./weekly-report-reading-turn";

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
  readingTurn,
}: {
  content: ReportContent;
  editable?: boolean;
  editableTabs?: boolean;
  placeholder: string;
  /** Bump to remount the active section editor (e.g. assistant insert). */
  contentRevision?: number;
  /** Special tabs appended after content.tabs (e.g. Leader 要点提炼). */
  trailingTabs?: readonly { id: string; label: string }[];
  renderTrailingTab?: (id: string) => ReactNode;
  onChange: (content: ReportContent) => void;
  onBlur?: () => void;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  /** Wheel at the body edge turns pages, then the next person of this template. */
  readingTurn?: {
    reportId: string;
    previousReportId: string | null;
    nextReportId: string | null;
    wheel: { current: ReadingWheelGesture };
    onOpenReport: (reportId: string, edge: ReadingEdge) => void;
  };
}) {
  const pages = content.tabs ?? { Summary: { markdown: content.markdown ?? "" } };
  const tabNames = Object.keys(pages);
  const trailing = trailingTabs ?? [];
  const allTabIds = [...tabNames, ...trailing.map((tab) => tab.id)];
  const [selectedTab, setSelectedTab] = useState(tabNames[0] ?? trailing[0]?.id ?? "");
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyScrollerRef = useRef<HTMLDivElement>(null);
  const contentEndRef = useRef<HTMLDivElement>(null);
  const scrollPlanRef = useRef<{ pageId: string; edge: ReadingEdge } | null>(null);
  const readingTurnRef = useRef(readingTurn);
  readingTurnRef.current = readingTurn;
  const pageIdsRef = useRef(allTabIds);
  pageIdsRef.current = allTabIds;
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false });
  const activeTab = allTabIds.includes(selectedTab)
    ? selectedTab
    : (tabNames[0] ?? trailing[0]?.id ?? "");
  const trailingActive = trailing.some((tab) => tab.id === activeTab);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

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
    const selected = scroller.querySelector('[aria-selected="true"]');
    if (!(selected instanceof HTMLElement)) return;
    selected.scrollIntoView({ inline: "nearest", block: "nearest" });
    updateTabOverflow();
  }, [activeTab]);

  useLayoutEffect(() => {
    if (!readingTurn) return;
    const edge = readReadingEdge(readingTurn.reportId);
    if (!edge) return;
    const pageId = edge === "end" ? (allTabIds.at(-1) ?? "") : (allTabIds[0] ?? "");
    if (!pageId) return;
    scrollPlanRef.current = { pageId, edge };
    setSelectedTab(pageId);
    const reportId = readingTurn.reportId;
    const timer = window.setTimeout(() => clearReadingEdge(reportId), 0);
    return () => window.clearTimeout(timer);
  }, [readingTurn?.reportId, allTabIds.join("\u0000")]);

  useLayoutEffect(() => {
    const plan = scrollPlanRef.current;
    const scroller = bodyScrollerRef.current;
    if (!plan || !scroller || plan.pageId !== activeTab) return;
    if (plan.edge === "start") {
      scroller.scrollTop = 0;
    } else if (contentEndRef.current) {
      const delta =
        contentEndRef.current.getBoundingClientRect().bottom -
        scroller.getBoundingClientRect().bottom;
      scroller.scrollTop += delta;
    }
    scrollPlanRef.current = null;
  }, [activeTab]);

  useEffect(() => {
    const scroller = bodyScrollerRef.current;
    if (!readingTurn || !scroller) return;
    const onWheel = (event: WheelEvent) => {
      const current = readingTurnRef.current;
      if (!current || event.ctrlKey || isReportImageZoomOpen()) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const deltaY = readingWheelPixels(event.deltaY, event.deltaMode, scroller.clientHeight);
      if (deltaY === 0 || nestedScrollOwnsWheel(event.target, scroller, deltaY)) return;
      const edge = measureBodyEdge(scroller, contentEndRef.current);
      if (!edge) return;
      const pinned = deltaY > 0 ? edge.atEnd : edge.atStart;
      const turned = noteReadingWheel(current.wheel.current, {
        deltaY,
        pinned,
        now: event.timeStamp || performance.now(),
      });
      current.wheel.current = turned.gesture;
      if (!pinned) return;
      event.preventDefault();
      if (turned.step === 0) return;
      const moved = stepMemberReportPage({
        pageIds: pageIdsRef.current,
        activePageId: activeTabRef.current,
        direction: turned.step,
        previousReportId: current.previousReportId,
        nextReportId: current.nextReportId,
      });
      if (moved.kind === "page") {
        scrollPlanRef.current = { pageId: moved.pageId, edge: moved.edge };
        setSelectedTab(moved.pageId);
      } else if (moved.kind === "report") {
        current.onOpenReport(moved.reportId, moved.edge);
      }
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [readingTurn?.reportId]);

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

  function addTab() {
    const name = defaultTabName();
    onChange({
      tabs: {
        ...pages,
        [name]: { markdown: "" },
      },
    });
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
    const renamed = Object.fromEntries(
      Object.entries(pages).map(([tabName, tab]) => [tabName === original ? name : tabName, tab]),
    );
    onChange({ tabs: renamed });
    if (activeTab === original) setSelectedTab(name);
  }

  function handleEditChange(event: ChangeEvent<HTMLInputElement>) {
    setEditingName(event.target.value);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitEditingTab();
    }
    if (event.key === "Escape") setEditingTab(null);
  }

  function moveTab(source: string, target: string) {
    if (source === target) return;
    const entries = Object.entries(pages);
    const sourceEntry = entries.find(([name]) => name === source);
    if (!sourceEntry) return;
    const remaining = entries.filter(([name]) => name !== source);
    const targetIndex = remaining.findIndex(([name]) => name === target);
    remaining.splice(targetIndex, 0, sourceEntry);
    onChange({ tabs: Object.fromEntries(remaining) });
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, name: string) {
    setDraggedTab(name);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", name);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, target: string) {
    event.preventDefault();
    const source = draggedTab ?? event.dataTransfer.getData("text/plain");
    if (source) moveTab(source, target);
    setDraggedTab(null);
  }

  function removeTab(name: string) {
    if (tabNames.length <= 1) return;
    const nextTabs = Object.fromEntries(
      Object.entries(pages).filter(([tabName]) => tabName !== name),
    );
    onChange({ tabs: nextTabs });
    if (activeTab === name) {
      const nextName = Object.keys(nextTabs)[0] ?? "";
      setSelectedTab(nextName);
    }
  }

  function updateMarkdown(markdown: string) {
    if (!editable) return;
    const tab = pages[activeTab];
    if (!tab) return;
    onChange({
      tabs: {
        ...pages,
        [activeTab]: { ...tab, markdown },
      },
    });
  }

  const activeContent = pages[activeTab]?.markdown ?? "";
  const readingTabs = !editableTabs;

  const tabButtonClass = (active: boolean) =>
    editableTabs
      ? cn(
          "rounded-lg px-3 py-1.5 text-sm",
          active
            ? "bg-primary font-medium text-primary shadow-xs ring-1 ring-secondary"
            : "bg-primary text-tertiary ring-1 ring-transparent hover:text-secondary",
        )
      : cn(
          "rounded-none px-1 pb-2.5 pt-1 text-sm",
          active
            ? "border-b-2 border-brand-solid font-semibold text-primary"
            : "border-b-2 border-transparent text-tertiary hover:text-secondary",
        );

  const chevronClass = cn("size-6 shrink-0 p-1 text-fg-quaternary", editableTabs ? "" : "mb-2");

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
        className={cn(
          // Overflow is driven by chevrons only — never show a native scrollbar under the tabs.
          "scrollbar-hide flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain pt-0",
          readingTabs ? "gap-8 sm:gap-10" : "gap-2",
        )}
      >
        {tabNames.map((name) => (
          <div
            key={name}
            draggable={editableTabs}
            onDragStart={(event) => handleDragStart(event, name)}
            onDragOver={(event) => {
              if (editableTabs) event.preventDefault();
            }}
            onDrop={(event) => handleDrop(event, name)}
            onDragEnd={() => setDraggedTab(null)}
            className={cn(
              "group flex shrink-0 items-center gap-0.5",
              draggedTab === name && "opacity-50",
            )}
          >
            {editingTab === name ? (
              <input
                autoFocus
                value={editingName}
                aria-label={`${m.records_template_dimension()}: ${name}`}
                onChange={handleEditChange}
                onBlur={commitEditingTab}
                onKeyDown={handleEditKeyDown}
                className={cn(
                  "h-8 w-28 min-w-0 bg-transparent px-0.5 text-sm font-semibold text-primary outline-none",
                  editableTabs
                    ? "rounded-lg border border-brand px-2"
                    : "mb-2 border-b-2 border-brand",
                )}
              />
            ) : (
              <Button
                type="button"
                size="sm"
                color="link-gray"
                aria-selected={name === activeTab}
                onPress={() => setSelectedTab(name)}
                onDoubleClick={() => startEditingTab(name)}
                className={tabButtonClass(name === activeTab)}
              >
                {name}
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
                className="size-5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              />
            ) : null}
          </div>
        ))}
        {trailing.map((tab) => (
          <div key={tab.id} className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              size="sm"
              color="link-gray"
              aria-selected={tab.id === activeTab}
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
          className="shrink-0 px-1"
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
          className={chevronClass}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0">
        <RecordsReadingColumn className={cn("pb-0", readingTabs ? "pt-2" : "pt-3")}>
          <div
            className={cn(
              "flex items-center gap-1",
              readingTabs
                ? "items-end border-b border-secondary/40"
                : "border-b border-transparent",
            )}
          >
            {tabBar}
          </div>
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
                className="min-h-[55vh]"
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
      ) : editableTabs ? (
        <LeaderFormatSectionsEditor
          key={`${activeTab}:${contentRevision}`}
          defaultValue={activeContent}
          onUpdate={updateMarkdown}
          onBlur={onBlur}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RecordsReadingColumn className="pt-5">
            <ReportSectionEditor
              key={`${activeTab}:${contentRevision}`}
              defaultValue={activeContent}
              placeholder={placeholder}
              className="min-h-[55vh] pb-[45vh]"
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
          onClose={() => setPresenting(false)}
        />
      ) : null}
    </div>
  );
}

function measureBodyEdge(scroller: HTMLElement, end: HTMLElement | null) {
  if (!end) return null;
  const contentEnd =
    end.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
  return contentEdgeReached({
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    contentEnd,
  });
}

function nestedScrollOwnsWheel(target: EventTarget | null, boundary: HTMLElement, deltaY: number) {
  let node = target instanceof Element ? target : null;
  while (node && node !== boundary) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        if (deltaY < 0 && node.scrollTop > 1) return true;
        if (deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}
