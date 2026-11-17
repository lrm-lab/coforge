import {
  COMMENT_DRAFT_HIGHLIGHT,
  NEUTRAL,
  type AnchorLocation,
  type SurfaceAdapter,
} from "./artifact-anchor-places";
import { setCssHighlight } from "#src/lib/css-highlight";
import { firstIndexWhere } from "./artifact-text-anchor";

type LineRow = { element: Element; line: number; endLine: number };

export type LineIndex = { rows: readonly LineRow[]; capped: boolean };

export type LineSpan = { start: number; end: number };

const GUTTER_PX = 56;

export const LINE_ROW_SELECTOR = "[data-anchor-line]";

export function buildLineIndex(root: Element): LineIndex {
  const rows = [...root.querySelectorAll(LINE_ROW_SELECTOR)].map((element) => {
    const line = Number(element.getAttribute("data-anchor-line"));
    return { element, line, endLine: Number(element.getAttribute("data-anchor-end") ?? line) };
  });
  return { rows, capped: root.querySelector("[data-anchor-capped]") !== null };
}

const rowAtLine = (index: LineIndex, line: number) =>
  index.rows[firstIndexWhere(index.rows, (row) => row.endLine >= line)];

function span(index: LineIndex, start: number, end: number) {
  const first = index.rows[firstIndexWhere(index.rows, (row) => row.endLine >= start)];
  const last = index.rows[firstIndexWhere(index.rows, (row) => row.line > end) - 1];
  return first && last && first.line <= end ? { first, last } : null;
}

function locationOf(first: LineRow, last: LineRow): AnchorLocation {
  const range = document.createRange();
  range.setStartBefore(first.element);
  range.setEndAfter(last.element);
  return { range, element: first.element, order: first.line };
}

export const linesAdapter: SurfaceAdapter<LineIndex, LineSpan> = {
  build(root) {
    const index = buildLineIndex(root);
    return index.rows.length === 0 ? null : index;
  },
  locate(index, anchor) {
    if (anchor.type !== "lines") return NEUTRAL;
    const start = Number(anchor.data.start);
    const end = Number(anchor.data.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return NEUTRAL;
    const covered = span(index, start, end);
    if (!covered || (covered.last.endLine < end && !index.capped)) return NEUTRAL;
    return { status: "found", location: locationOf(covered.first, covered.last) };
  },
  fromSelection(index, selection) {
    const first = rowAtLine(index, selection.start);
    const last = rowAtLine(index, selection.end);
    if (!first || !last) return null;
    const { top, left } = first.element.getBoundingClientRect();
    const { bottom } = last.element.getBoundingClientRect();
    const range = document.createRange();
    range.setStartBefore(first.element);
    range.setEndAfter(last.element);
    const x = left + GUTTER_PX;
    return {
      anchor: { type: "lines", data: { start: first.line, end: last.endLine } },
      target: {
        rect: { top, bottom, left: x, right: x, width: 0, height: bottom - top },
        highlight: (on) => setCssHighlight(COMMENT_DRAFT_HIGHLIGHT, on ? [range] : []),
      },
    };
  },
};
