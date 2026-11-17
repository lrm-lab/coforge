import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { formatFileSize } from "#src/features/files/file-meta";
import type { ArtifactPathKind } from "./artifact-path-kind";

export type ArtifactEntryFacts = {
  sizeBytes: number;
  pages?: number;
  lines?: number;
  rows?: number;
  columns?: number;
  columnNames?: string[];
  width?: number;
  height?: number;
};

export function entryFactsLine(kind: ArtifactPathKind, facts: ArtifactEntryFacts | null) {
  if (!facts) return null;
  const number = new Intl.NumberFormat(getLocale()).format;
  const parts: string[] = [];
  if (kind === "pdf" && facts.pages !== undefined)
    parts.push(m.doc_facts_pages({ count: facts.pages, shown: number(facts.pages) }));
  if (kind === "text" && facts.lines !== undefined)
    parts.push(m.doc_facts_lines({ count: facts.lines, shown: number(facts.lines) }));
  if (kind === "csv" && facts.rows !== undefined && facts.columns !== undefined)
    parts.push(
      m.doc_facts_table({
        rows: m.doc_facts_rows({ count: facts.rows, shown: number(facts.rows) }),
        columns: m.doc_facts_columns({ count: facts.columns, shown: number(facts.columns) }),
      }),
    );
  if (kind === "csv" && facts.columnNames?.length)
    parts.push(facts.columnNames.join(m.doc_facts_name_separator()));
  if (kind === "image" && facts.width !== undefined && facts.height !== undefined)
    parts.push(m.doc_facts_pixels({ width: number(facts.width), height: number(facts.height) }));
  if (parts.length === 0) parts.push(formatFileSize(facts.sizeBytes));
  return parts.join(" · ");
}
