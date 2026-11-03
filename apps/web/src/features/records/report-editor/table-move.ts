import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import type { ActiveTable } from "./table-geometry";

function moveArrayItem<T>(items: T[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (!item) return items;
  next.splice(to, 0, item);
  return next;
}

export function destinationFromGap(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

function replaceTable(editor: Editor, table: ActiveTable, nextTable: ProseMirrorNode) {
  const tr = editor.state.tr.replaceWith(table.pos, table.pos + table.node.nodeSize, nextTable);
  tr.setSelection(NodeSelection.create(tr.doc, table.pos));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

export function moveTableRow(editor: Editor, table: ActiveTable, from: number, to: number) {
  const rows = Array.from({ length: table.node.childCount }, (_, index) => table.node.child(index));
  const movedRows = moveArrayItem(rows, from, to);
  if (movedRows === rows) return;
  replaceTable(editor, table, table.node.copy(Fragment.fromArray(movedRows)));
}

export function moveTableColumn(editor: Editor, table: ActiveTable, from: number, to: number) {
  const rows: ProseMirrorNode[] = [];
  for (let rowIndex = 0; rowIndex < table.node.childCount; rowIndex += 1) {
    const row = table.node.child(rowIndex);
    const cells = Array.from({ length: row.childCount }, (_, index) => row.child(index));
    rows.push(row.copy(Fragment.fromArray(moveArrayItem(cells, from, to))));
  }
  replaceTable(editor, table, table.node.copy(Fragment.fromArray(rows)));
}
