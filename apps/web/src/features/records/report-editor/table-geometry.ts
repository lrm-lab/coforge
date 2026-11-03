import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";

export type ActiveTable = {
  node: ProseMirrorNode;
  pos: number;
  rows: number;
  cols: number;
  wrapperRect: DOMRect;
  rect: DOMRect;
  rowRects: DOMRect[];
  colRects: DOMRect[];
  selectionRect: DOMRect | null;
  selected: boolean;
};

export type Axis = "row" | "column";

export type OpenMenu = { type: Axis; index: number; tablePos: number };

export function findActiveTable(
  editor: Editor,
): { node: ProseMirrorNode; pos: number; selected: boolean } | null {
  const { selection, doc } = editor.state;
  if (!selection) return null;
  if (selection instanceof NodeSelection && selection.node.type.name === "table") {
    return { node: selection.node, pos: selection.from, selected: true };
  }
  const { $from } = selection;
  // Partial editor mocks (and briefly-unready views) may omit ResolvedPos.
  if (!$from) return null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "table") return { node, pos: $from.before(depth), selected: false };
  }
  const maybeTable = doc.nodeAt(selection.from);
  return maybeTable?.type.name === "table"
    ? { node: maybeTable, pos: selection.from, selected: false }
    : null;
}

function getTableDom(editor: Editor, tablePos: number): HTMLTableElement | null {
  const dom = editor.view.nodeDOM(tablePos);
  if (!(dom instanceof HTMLElement)) return null;
  if (dom instanceof HTMLTableElement) return dom;
  return dom.querySelector("table");
}

function relativeRect(rect: DOMRect, root: DOMRect): DOMRect {
  return new DOMRect(rect.left - root.left, rect.top - root.top, rect.width, rect.height);
}

function unionClientRects(elements: Element[]): DOMRect | null {
  if (elements.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left)) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

export function measureTable(
  editor: Editor,
  root: HTMLElement,
  tableInfo: { node: ProseMirrorNode; pos: number; selected: boolean },
): ActiveTable | null {
  const tableDom = getTableDom(editor, tableInfo.pos);
  if (!tableDom) return null;
  const rootRect = root.getBoundingClientRect();
  const wrapperDom =
    tableDom.closest(".tableWrapper") instanceof HTMLElement
      ? (tableDom.closest(".tableWrapper") as HTMLElement)
      : tableDom;
  const rows = Array.from(tableDom.querySelectorAll(":scope > tbody > tr"));
  const firstRowCells = rows[0] ? Array.from(rows[0].children) : [];
  const selectedUnion = unionClientRects(Array.from(tableDom.querySelectorAll(".selectedCell")));
  const live = editor.state.doc.nodeAt(tableInfo.pos);
  const node = live?.type.name === "table" ? live : tableInfo.node;
  return {
    node,
    pos: tableInfo.pos,
    selected: tableInfo.selected,
    rows: node.childCount,
    cols: node.firstChild?.childCount ?? 0,
    wrapperRect: relativeRect(wrapperDom.getBoundingClientRect(), rootRect),
    rect: relativeRect(tableDom.getBoundingClientRect(), rootRect),
    rowRects: rows.map((row) => relativeRect(row.getBoundingClientRect(), rootRect)),
    colRects: firstRowCells.map((cell) => relativeRect(cell.getBoundingClientRect(), rootRect)),
    selectionRect: selectedUnion ? relativeRect(selectedUnion, rootRect) : null,
  };
}
