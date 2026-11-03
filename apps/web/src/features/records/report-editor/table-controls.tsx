"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { Plus, Trash01 as Trash2 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useDocumentDragCursor } from "#src/hooks/use-document-drag-cursor";
import { cn } from "#src/lib/utils";
import { useT } from "./i18n";
import { ColumnHandle, RowHandle } from "./table-axis-handle";
import {
  findActiveTable,
  measureTable,
  type ActiveTable,
  type Axis,
  type OpenMenu,
} from "./table-geometry";
import { destinationFromGap, moveTableColumn, moveTableRow } from "./table-move";
import {
  deleteTableAt,
  insertColumnAt,
  insertRowAt,
  isColumnResizeDragging,
  selectColumnAt,
  selectRowAt,
} from "./table-ops";

type DragState = {
  type: Axis;
  from: number;
  insertGap: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

const DRAG_THRESHOLD_PX = 4;
const ROW_HANDLE_OUTSET = 18;
const COL_HANDLE_OUTSET = 14;

function edgeAddClass() {
  return cn(
    "flex items-center justify-center rounded-md text-quaternary",
    "hover:bg-primary_hover hover:text-tertiary",
  );
}

type OverlayState = {
  activeTable: ActiveTable | null;
  columnResizing: boolean;
};

export function TableControls({
  editor,
  rootRef,
}: {
  editor: Editor;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useT("editor");
  const [overlay, setOverlay] = useState<OverlayState>({
    activeTable: null,
    columnResizing: false,
  });
  const [drag, setDrag] = useState<DragState | null>(null);
  useDocumentDragCursor(drag?.dragging === true);
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const activeTableRef = useRef<ActiveTable | null>(null);
  const openMenuRef = useRef<OpenMenu | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const skipMenuOpenRef = useRef(false);
  const menuOpenAtDownRef = useRef(false);

  const { activeTable, columnResizing } = overlay;
  openMenuRef.current = openMenu;

  useEffect(() => {
    if (editor.isDestroyed) return;

    const update = () => {
      if (editor.isDestroyed) return;
      const root = rootRef.current;
      if (!root) return;

      // Column-resize updates DOM widths on every mousemove. Remeasuring /
      // re-rendering our overlays mid-drag makes the dragged edge jump.
      const resizing = isColumnResizeDragging(editor);
      let nextTable: ActiveTable | null | undefined;
      if (resizing) {
        nextTable = undefined; // keep previous activeTable
      } else {
        const tableInfo = findActiveTable(editor);
        nextTable = tableInfo ? measureTable(editor, root, tableInfo) : null;

        // Keep the last table pinned while a handle menu is open or a drag is in
        // progress. Otherwise blur-from-menu unmounts controls before the action runs.
        if (!nextTable) {
          const pinnedPos = openMenuRef.current?.tablePos ?? activeTableRef.current?.pos;
          if ((openMenuRef.current || dragRef.current) && typeof pinnedPos === "number") {
            const live = editor.state.doc.nodeAt(pinnedPos);
            if (live?.type.name === "table") {
              nextTable = measureTable(editor, root, {
                node: live,
                pos: pinnedPos,
                selected: false,
              });
            }
          }
        }

        if (!nextTable && !openMenuRef.current && !dragRef.current) {
          nextTable = null;
        } else if (!nextTable) {
          nextTable = undefined;
        }
      }

      setOverlay((prev) => {
        const activeTable = nextTable === undefined ? prev.activeTable : nextTable;
        if (nextTable !== undefined) activeTableRef.current = nextTable;
        if (prev.activeTable === activeTable && prev.columnResizing === resizing) {
          return prev;
        }
        return { activeTable, columnResizing: resizing };
      });
    };
    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [editor, rootRef]);

  if (!activeTable || !editor.isEditable) return null;

  const runMenuAction = (action: () => boolean) => {
    action();
    setOpenMenu(null);
  };

  const gapFromPointer = (type: Axis, clientX: number, clientY: number) => {
    const table = activeTableRef.current;
    const root = rootRef.current;
    if (!table || !root) return 0;
    const rootRect = root.getBoundingClientRect();
    const point = type === "row" ? clientY - rootRect.top : clientX - rootRect.left;
    const rects = type === "row" ? table.rowRects : table.colRects;
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index]!;
      const start = type === "row" ? rect.top : rect.left;
      const size = type === "row" ? rect.height : rect.width;
      if (point < start + size / 2) return index;
    }
    return rects.length;
  };

  const onHandlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    type: Axis,
    index: number,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    skipMenuOpenRef.current = false;
    menuOpenAtDownRef.current = openMenu?.type === type && openMenu.index === index;
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: DragState = {
      type,
      from: index,
      insertGap: index,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    dragRef.current = next;
    setDrag(next);
    if (type === "row") selectRowAt(editor, activeTable.pos, index);
    else selectColumnAt(editor, activeTable.pos, index);
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
    const insertGap = gapFromPointer(current.type, event.clientX, event.clientY);
    const dragging = current.dragging || distance >= DRAG_THRESHOLD_PX;
    if (dragging) skipMenuOpenRef.current = true;
    const next = { ...current, dragging, insertGap };
    dragRef.current = next;
    setDrag(next);
  };

  const onHandlePointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
    type: Axis,
    index: number,
  ) => {
    const current = dragRef.current;
    const table = activeTableRef.current;
    dragRef.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!current || !table) return;
    if (current.dragging) {
      const to = destinationFromGap(current.from, current.insertGap);
      if (to !== current.from) {
        if (current.type === "row") moveTableRow(editor, table, current.from, to);
        else moveTableColumn(editor, table, current.from, to);
      }
      setOpenMenu(null);
      return;
    }
    if (!skipMenuOpenRef.current) {
      setOpenMenu(menuOpenAtDownRef.current ? null : { type, index, tablePos: table.pos });
    }
  };

  const visibleLeft = activeTable.wrapperRect.left;
  const visibleRight = activeTable.wrapperRect.left + activeTable.wrapperRect.width;
  const visibleBottom = activeTable.wrapperRect.top + activeTable.wrapperRect.height;
  const tableLeft = activeTable.rect.left;
  const tableTop = activeTable.rect.top;
  const tableRight = activeTable.rect.left + activeTable.rect.width;

  // Sit against the table's right edge (not the full-width wrapper). When the
  // table overflows horizontally, clamp so the control stays in view.
  const addColumnStyle: CSSProperties = {
    left: Math.min(tableRight + 2, Math.max(visibleLeft, visibleRight - 18)),
    top: tableTop,
    width: 18,
    height: Math.min(activeTable.rect.height, activeTable.wrapperRect.height),
  };
  const addRowStyle: CSSProperties = {
    left: tableLeft,
    top: visibleBottom + 4,
    width: Math.min(activeTable.rect.width, activeTable.wrapperRect.width),
    height: 18,
  };
  const colVisible = (rect: DOMRect) =>
    rect.left + rect.width > visibleLeft + 2 && rect.left < visibleRight - 2;

  const dropIndicatorStyle = (): CSSProperties | null => {
    if (!drag?.dragging) return null;
    if (destinationFromGap(drag.from, drag.insertGap) === drag.from) return null;

    if (drag.type === "row") {
      const gap = drag.insertGap;
      const y =
        gap <= 0
          ? (activeTable.rowRects[0]?.top ?? tableTop)
          : gap >= activeTable.rowRects.length
            ? (activeTable.rowRects.at(-1)?.top ?? 0) + (activeTable.rowRects.at(-1)?.height ?? 0)
            : activeTable.rowRects[gap]!.top;
      return {
        left: tableLeft,
        top: y - 1,
        width: Math.min(activeTable.rect.width, activeTable.wrapperRect.width),
        height: 2,
      };
    }

    const gap = drag.insertGap;
    const x =
      gap <= 0
        ? (activeTable.colRects[0]?.left ?? tableLeft)
        : gap >= activeTable.colRects.length
          ? (activeTable.colRects.at(-1)?.left ?? 0) + (activeTable.colRects.at(-1)?.width ?? 0)
          : activeTable.colRects[gap]!.left;
    const clampedLeft = Math.min(Math.max(x, visibleLeft), visibleRight);
    return {
      left: clampedLeft - 1,
      top: tableTop,
      width: 2,
      height: activeTable.rect.height,
    };
  };

  const dropStyle = dropIndicatorStyle();

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-visible">
      {activeTable.selectionRect && !drag?.dragging && !columnResizing && (
        <div
          aria-hidden
          className="absolute z-[1] border border-brand"
          style={{
            left: activeTable.selectionRect.left,
            top: activeTable.selectionRect.top,
            width: activeTable.selectionRect.width,
            height: activeTable.selectionRect.height,
          }}
        />
      )}

      {dropStyle && (
        <div aria-hidden className="absolute z-[2] rounded-full bg-brand" style={dropStyle} />
      )}

      <div
        className="pointer-events-auto absolute flex items-center gap-1"
        style={{ left: Math.max(0, tableLeft - 2), top: Math.max(0, tableTop - 26) }}
      >
        <Tooltip title={t(($) => $.table_controls.select_table)}>
          <AriaButton
            type="button"
            className={cn(
              "flex size-5 items-center justify-center rounded-md text-quaternary",
              "hover:bg-primary_hover hover:text-tertiary",
              activeTable.selected && "bg-primary_hover text-primary",
            )}
            aria-label={t(($) => $.table_controls.select_table)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpenMenu(null);
              const tr = editor.state.tr.setSelection(
                NodeSelection.create(editor.state.doc, activeTable.pos),
              );
              editor.view.dispatch(tr);
              editor.view.focus();
            }}
          >
            <span className="grid grid-cols-2 gap-0.5" aria-hidden>
              <span className="size-1 rounded-[1px] bg-current opacity-70" />
              <span className="size-1 rounded-[1px] bg-current opacity-70" />
              <span className="size-1 rounded-[1px] bg-current opacity-70" />
              <span className="size-1 rounded-[1px] bg-current opacity-70" />
            </span>
          </AriaButton>
        </Tooltip>
        {activeTable.selected && (
          <Tooltip title={t(($) => $.table_controls.delete_table)}>
            <AriaButton
              type="button"
              className="flex size-5 items-center justify-center rounded-md text-quaternary hover:bg-primary_hover hover:text-error-primary"
              aria-label={t(($) => $.table_controls.delete_table)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                // TipTap deleteTable() walks cell ancestors and fails when the
                // table itself is NodeSelected — delete by position instead.
                const tablePos = activeTable.pos;
                setOpenMenu(null);
                deleteTableAt(editor, tablePos);
              }}
            >
              <Trash2 className="size-3.5" />
            </AriaButton>
          </Tooltip>
        )}
      </div>

      <Tooltip title={t(($) => $.table_controls.add_column)}>
        <AriaButton
          type="button"
          className={cn("pointer-events-auto absolute", edgeAddClass())}
          style={addColumnStyle}
          aria-label={t(($) => $.table_controls.add_column)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertColumnAt(editor, activeTable.pos, activeTable.cols)}
        >
          <Plus className="size-3.5" />
        </AriaButton>
      </Tooltip>

      <Tooltip title={t(($) => $.table_controls.add_row)}>
        <AriaButton
          type="button"
          className={cn("pointer-events-auto absolute", edgeAddClass())}
          style={addRowStyle}
          aria-label={t(($) => $.table_controls.add_row)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertRowAt(editor, activeTable.pos, activeTable.rows)}
        >
          <Plus className="size-3.5" />
        </AriaButton>
      </Tooltip>

      {activeTable.colRects.map((rect, col) => {
        if (!colVisible(rect)) return null;
        const handleId = `${activeTable.pos}:col:${col}`;
        const menuOpen = openMenu?.type === "column" && openMenu.index === col;
        const dropTarget =
          drag?.type === "column" &&
          drag.dragging &&
          destinationFromGap(drag.from, drag.insertGap) === col;
        const handleLeft = Math.max(rect.left, visibleLeft);
        const handleRight = Math.min(rect.left + rect.width, visibleRight);
        const zoneWidth = Math.max(20, handleRight - handleLeft);
        const menuTablePos = openMenu?.tablePos ?? activeTable.pos;
        return (
          <div
            key={handleId}
            className="pointer-events-none absolute"
            style={{
              left: handleLeft,
              top: tableTop - COL_HANDLE_OUTSET,
              width: zoneWidth,
              height: COL_HANDLE_OUTSET,
            }}
          >
            <ColumnHandle
              editor={editor}
              activeTable={activeTable}
              col={col}
              menuOpen={menuOpen}
              dropTarget={dropTarget}
              menuTablePos={menuTablePos}
              setOpenMenu={setOpenMenu}
              runMenuAction={runMenuAction}
              onHandlePointerDown={onHandlePointerDown}
              onHandlePointerMove={onHandlePointerMove}
              onHandlePointerUp={onHandlePointerUp}
            />
          </div>
        );
      })}

      {activeTable.rowRects.map((rect, row) => {
        const handleId = `${activeTable.pos}:row:${row}`;
        const menuOpen = openMenu?.type === "row" && openMenu.index === row;
        const dropTarget =
          drag?.type === "row" &&
          drag.dragging &&
          destinationFromGap(drag.from, drag.insertGap) === row;
        const menuTablePos = openMenu?.tablePos ?? activeTable.pos;
        return (
          <div
            key={handleId}
            className="pointer-events-none absolute"
            style={{
              // Sit just outside the cell grid — no table indentation required.
              left: tableLeft - ROW_HANDLE_OUTSET,
              top: rect.top,
              width: ROW_HANDLE_OUTSET,
              height: rect.height,
            }}
          >
            <RowHandle
              editor={editor}
              activeTable={activeTable}
              row={row}
              menuOpen={menuOpen}
              dropTarget={dropTarget}
              menuTablePos={menuTablePos}
              setOpenMenu={setOpenMenu}
              runMenuAction={runMenuAction}
              onHandlePointerDown={onHandlePointerDown}
              onHandlePointerMove={onHandlePointerMove}
              onHandlePointerUp={onHandlePointerUp}
            />
          </div>
        );
      })}
    </div>
  );
}
