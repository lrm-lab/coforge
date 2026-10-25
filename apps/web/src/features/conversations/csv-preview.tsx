import { memo, useMemo, useRef } from "react";
import { rangeAnchor, useSelectionComment, type Anchoring } from "./attachment-anchoring";
import { useProgressiveChunks, useRangeSurface } from "./anchored-previews";
import { parseCsv } from "./csv-table";

/** Rows a column's starting width is estimated from. */
const CSV_WIDTH_SAMPLE_ROWS = 200;
/** The narrowest and widest a column starts out, in characters. */
const CSV_COLUMN_CH = { min: 4, max: 40 };
const CSV_ROW = "grid grid-cols-(--csv-columns)";
/** A row's height before the browser lays it out, for chunks it skips (`content-visibility`). */
const CSV_ROW_ESTIMATE_PX = 33;
const toRowAnchor = rangeAnchor("csv-rows", "data-anchor-row");

/**
 * A CSV attachment as a table: the first record is the header, and each data row carries its
 * number (from 1, header excluded), which is what a comment on rows points at. Cells are React
 * text, so nothing in the file is ever parsed as markup. Column widths are fixed from the header
 * and the first rows: a `<table>` would re-measure every row as each chunk arrives, which on a
 * 2 MB file blocks the page for over a second, so this is a grid with table roles instead.
 */
export function CsvPreview({ text, anchoring }: { text: string; anchoring?: Anchoring }) {
  const ref = useRef<HTMLDivElement>(null);
  const { header, rows, rowTexts, columns } = useMemo(() => {
    let texts: string[] | undefined;
    const [first = [], ...rest] = parseCsv(text);
    const width = rest.reduce((widest, row) => Math.max(widest, row.length), first.length);
    const sample = [first, ...rest.slice(0, CSV_WIDTH_SAMPLE_ROWS)];
    return {
      header: first,
      rows: rest,
      // Built on first use: only placing a comment needs each row as one string.
      rowTexts: () => (texts ??= rest.map((row) => row.join(" "))),
      columns: Array.from({ length: width }, (_, column) =>
        Math.min(
          CSV_COLUMN_CH.max,
          Math.max(CSV_COLUMN_CH.min, ...sample.map((row) => row[column]?.length ?? 0)),
        ),
      ),
    };
  }, [text]);
  const { chunks, ensure } = useProgressiveChunks(rows.length);
  const commentButton = useSelectionComment(ref, toRowAnchor, anchoring);
  useRangeSurface(anchoring, "csv-rows", rowTexts, ref, ensure);
  const numberCh = String(rows.length).length;
  // One column template for the header and every row, so columns line up across row chunks.
  // The last column takes what is left, so row borders and marks reach the pane's edge.
  const template = [numberCh, ...columns]
    .map((ch, i) =>
      i === columns.length ? `minmax(calc(${ch}ch + 1.5rem), 1fr)` : `calc(${ch}ch + 1.5rem)`,
    )
    .join(" ");
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto">
      <div
        role="table"
        className="w-max min-w-full text-sm text-primary"
        style={{ "--csv-columns": template } as React.CSSProperties}
      >
        <div role="rowgroup" className="sticky top-0 z-10 bg-secondary">
          <div role="row" className={CSV_ROW}>
            <span role="columnheader" className="border-b border-secondary px-3 py-2" />
            {columns.map((_, column) => (
              <span
                key={column}
                role="columnheader"
                className="border-b border-secondary px-3 py-2 font-semibold break-words whitespace-pre-wrap"
              >
                {header[column] ?? ""}
              </span>
            ))}
          </div>
        </div>
        {chunks.map(([start, end]) => (
          <CsvRows key={start} rows={rows} start={start} end={end} columns={columns.length} />
        ))}
      </div>
      {commentButton}
    </div>
  );
}

/**
 * One chunk of rows. Laid out only near the viewport (`content-visibility: auto`): a 2 MB CSV is
 * some 200,000 cells, and laying all of them out on every new chunk blocks the page.
 */
const CsvRows = memo(function CsvRows({
  rows,
  start,
  end,
  columns,
}: {
  rows: readonly string[][];
  start: number;
  end: number;
  columns: number;
}) {
  const chunk = rows.slice(start, end);
  return (
    <div
      role="rowgroup"
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${chunk.length * CSV_ROW_ESTIMATE_PX}px`,
      }}
    >
      {chunk.map((row, index) => (
        <div key={start + index} role="row" data-anchor-row={start + index + 1} className={CSV_ROW}>
          <span
            role="rowheader"
            className="border-b border-secondary px-3 py-1.5 text-right text-tertiary tabular-nums select-none"
          >
            {start + index + 1}
          </span>
          {Array.from({ length: columns }, (_, column) => (
            <span
              key={column}
              role="cell"
              className="border-b border-secondary px-3 py-1.5 break-words whitespace-pre-wrap"
            >
              {row[column] ?? ""}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
});
