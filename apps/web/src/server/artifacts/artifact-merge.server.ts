import { diffArrays } from "diff";
import { AppError } from "#src/lib/app-error";
import {
  ARTIFACT_DOCUMENT_LIMIT,
  type ArtifactBlobStore,
  type ArtifactFileRow,
} from "./artifact-files.server";

/**
 * How a save over an older version keeps what others changed since its base (task #385). Files
 * merge by path in `Artifacts.push`; this module merges what is inside them and around them.
 */

/** An artifact's settings, which a version records and a save may change. */
export const ARTIFACT_SETTINGS = ["title", "description", "entryPath"] as const;
export type ArtifactSettingName = (typeof ARTIFACT_SETTINGS)[number];
export type ArtifactSettings = Record<ArtifactSettingName, string>;

/** One setting both sides changed, to different values. `base` is null when the save's base
 * is the artifact before its first version, whose settings no version recorded. */
export type ArtifactSettingConflict = {
  name: ArtifactSettingName;
  base: string | null;
  mine: string;
  theirs: string;
};

/** A piece of a text file that did not merge, in file order: text both sides agree on, or a
 * place each side changed differently since the base (`base` is that place before either). */
export type ArtifactTextChunk =
  | { ok: string }
  | { conflict: { base: string; mine: string; theirs: string } };

/** The answer to a save that cannot be merged: nothing was written. The client resolves each
 * conflict (for a file, joining the chunks with one side picked at each conflict), then saves
 * again with `currentVersion` as its base. */
export type ArtifactConflict = {
  status: "conflict";
  currentVersion: number;
  files: { path: string; chunks: ArtifactTextChunk[] }[];
  settings: ArtifactSettingConflict[];
};

/**
 * Merges a text file line by line (a three-way merge over each side's Myers diff against the
 * base): changes to different paragraphs both land, as does a paragraph added or removed next to
 * one the others edited; the same lines changed on both sides, or removed on one and changed on
 * the other, are a conflict. Lines keep their own endings, so the merge gives back exactly the
 * text it joined.
 */
export function mergeText(
  base: string,
  mine: string,
  theirs: string,
): { text: string } | { chunks: ArtifactTextChunk[] } {
  const original = lines(base);
  const ours = hunks(original, lines(mine));
  const others = hunks(original, lines(theirs));
  // Too different to align in bounded time: the whole file is one conflict.
  if (!ours || !others) return { chunks: [{ conflict: { base, mine, theirs } }] };

  const chunks: ArtifactTextChunk[] = [];
  const keep = (text: string) => {
    if (!text) return;
    const last = chunks.at(-1);
    if (last && "ok" in last) last.ok += text;
    else chunks.push({ ok: text });
  };
  let at = 0;
  for (const group of groups(original, ours, others)) {
    keep(original.slice(at, group.start).join(""));
    const mineText = apply(original, group.start, group.end, group.ours);
    const theirsText = apply(original, group.start, group.end, group.others);
    if (!group.ours.length) keep(theirsText);
    else if (!group.others.length || mineText === theirsText) keep(mineText);
    else
      chunks.push({
        conflict: {
          base: original.slice(group.start, group.end).join(""),
          mine: mineText,
          theirs: theirsText,
        },
      });
    at = group.end;
  }
  keep(original.slice(at).join(""));
  if (chunks.every((chunk) => "ok" in chunk))
    return { text: chunks.map((chunk) => ("ok" in chunk ? chunk.ok : "")).join("") };
  return { chunks };
}

/** A text's lines, each with its own line ending; the last may have none. */
const lines = (text: string) => text.split(/(?<=\n)/).filter((line) => line !== "");

/** Lines `start..end` of the base replaced by `lines`; `start === end` is an insertion. */
type Hunk = { start: number; end: number; lines: string[] };

/** Past either bound a side is not aligned at all, and the whole file is one conflict: Myers'
 * diff costs about D² for D changes, and a save waits for it under the artifact's lock. The
 * timeout is wall-clock, so near it (some 2,000 scattered edits per side in a 2 MiB document) the
 * same save may merge on an idle server and conflict on a busy one; either way nothing is lost.
 * Removing the last paragraph also takes the blank line above it, so a paragraph the others add
 * right before it conflicts where the same pair mid-document merges; that too fails closed. */
const MAX_EDIT_LENGTH = 4_000;
const DIFF_TIMEOUT_MS = 1_000;

/** One side's changes to the base, by Myers' diff; null when there are too many to align. */
function hunks(base: string[], side: string[]): Hunk[] | null {
  const parts = diffArrays(base, side, {
    maxEditLength: MAX_EDIT_LENGTH,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (!parts) return null;
  const found: Hunk[] = [];
  let at = 0;
  let open: Hunk | null = null;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (open) found.push(open);
      open = null;
      at += part.count;
      continue;
    }
    open ??= { start: at, end: at, lines: [] };
    if (part.removed) {
      open.end += part.count;
      at += part.count;
    } else open.lines.push(...part.value);
  }
  if (open) found.push(open);
  return found;
}

const blank = (line: string | undefined) => line !== undefined && line.trim() === "";

/** For every base line, the paragraph it is in: where it starts and where it ends (exclusive).
 * A paragraph runs between blank lines; a blank line is its own. One pass, so a merge costs no
 * more than its diffs however long a paragraph is. */
function paragraphIndex(base: string[]) {
  const start = new Int32Array(base.length);
  const end = new Int32Array(base.length);
  for (let line = 0; line < base.length; line += 1)
    start[line] =
      !blank(base[line]) && line > 0 && !blank(base[line - 1]) ? start[line - 1]! : line;
  for (let line = base.length - 1; line >= 0; line -= 1)
    end[line] =
      !blank(base[line]) && line + 1 < base.length && !blank(base[line + 1])
        ? end[line + 1]!
        : line + 1;
  return { start, end };
}

/**
 * The base lines a hunk's change belongs to, as whole paragraphs. A change covers the
 * paragraphs of the lines it replaces, and a neighbouring paragraph it runs into: one whose edge
 * line ends up next to a line that is not blank (joining two paragraphs covers both). An
 * insertion covers the paragraph it joins in the same way; one that carries its own blank
 * separator joins none, and covers nothing at its place.
 */
function paragraphs(
  base: string[],
  index: ReturnType<typeof paragraphIndex>,
  hunk: Hunk,
): { start: number; end: number } {
  const { start: s, end: e, lines: added } = hunk;
  const before = added.length ? added.at(-1) : base[s - 1];
  const after = added.length ? added[0] : base[e];
  const above = s > 0 && !blank(base[s - 1]) && after !== undefined && !blank(after);
  const below = e < base.length && !blank(base[e]) && before !== undefined && !blank(before);
  let start = above ? index.start[s - 1]! : s;
  let end = below ? index.end[e]! : e;
  if (e > s) {
    start = Math.min(start, index.start[s]!);
    end = Math.max(end, index.end[e - 1]!);
  }
  return { start, end };
}

/**
 * Both sides' hunks, in base order, gathered where the paragraphs they cover overlap: changes to
 * the same paragraph are one group, which conflicts unless both sides made it the same. So a
 * paragraph added or removed next to one the others edited merges, while a line added to a
 * paragraph the others removed, or two different paragraphs added at one place, conflicts.
 */
function groups(base: string[], ours: Hunk[], others: Hunk[]) {
  const index = paragraphIndex(base);
  const all = [
    ...ours.map((hunk) => ({ hunk, side: "ours" as const })),
    ...others.map((hunk) => ({ hunk, side: "others" as const })),
  ]
    .map((entry) => ({ ...entry, span: paragraphs(base, index, entry.hunk) }))
    .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  const found: { start: number; end: number; ours: Hunk[]; others: Hunk[] }[] = [];
  for (const { hunk, side, span } of all) {
    const group = found.at(-1);
    const empty = span.start === span.end;
    const joins =
      group !== undefined &&
      (empty
        ? // At one place as another insertion, or inside the paragraphs another change covers.
          (span.start === group.start && group.start === group.end) ||
          (span.start > group.start && span.start < group.end)
        : span.start < group.end);
    if (!joins) found.push({ start: span.start, end: span.end, ours: [], others: [] });
    const into = found.at(-1)!;
    into.start = Math.min(into.start, hunk.start);
    into.end = Math.max(into.end, span.end, hunk.end);
    into[side].push(hunk);
  }
  return found;
}

/** The base's lines `start..end` with one side's hunks there applied. */
function apply(base: string[], start: number, end: number, side: Hunk[]): string {
  let text = "";
  let at = start;
  for (const hunk of side) {
    text += base.slice(at, hunk.start).join("") + hunk.lines.join("");
    at = hunk.end;
  }
  return text + base.slice(at, end).join("");
}

/**
 * Merges settings item by item, as Raft does: an item only one side changed takes that side's
 * value, and one both changed to the same value is no conflict. With no recorded base (the save
 * began before the first version), any difference is a conflict: nothing is overwritten unseen.
 * `merged` names the items whose value came from the others.
 */
export function mergeSettings(
  base: ArtifactSettings | null,
  current: ArtifactSettings,
  mine: Partial<ArtifactSettings>,
): {
  result: ArtifactSettings;
  merged: ArtifactSettingName[];
  conflicts: ArtifactSettingConflict[];
} {
  const result = { ...current };
  const merged: ArtifactSettingName[] = [];
  const conflicts: ArtifactSettingConflict[] = [];
  for (const name of ARTIFACT_SETTINGS) {
    const theirs = current[name];
    const before = base?.[name] ?? null;
    const othersChanged = before !== null && theirs !== before;
    const value = mine[name];
    if (value === undefined || value === theirs || value === before) {
      if (othersChanged) merged.push(name);
      continue;
    }
    if (before !== null && !othersChanged) result[name] = value;
    else conflicts.push({ name, base: before, mine: value, theirs });
  }
  return { result, merged, conflicts };
}

/**
 * The document's own file, both sides changed, merged line by line: the merged file (stored as a
 * new blob, its row in the save's transaction), or the conflicting chunks. Null for any other
 * file, a binary side, or a file the others deleted, which only a human merges. The document is
 * at most 2 MiB (checked before the save locks), which bounds the merge. A file both sides added
 * has an empty base.
 */
export async function mergeDocumentFile(
  blobs: Pick<ArtifactBlobStore, "read" | "upload">,
  workspaceId: string,
  document: boolean,
  sides: { base?: ArtifactFileRow; theirs?: ArtifactFileRow; mine: ArtifactFileRow },
): Promise<ArtifactFileRow | { chunks: ArtifactTextChunk[] } | null> {
  const { base, theirs, mine } = sides;
  if (!document || !theirs) return null;
  // Checked here, on the document this merge reads: the entry path is the merged settings'.
  if (mine.sizeBytes > ARTIFACT_DOCUMENT_LIMIT) tooLarge();
  if ([base, theirs].some((side) => side && side.sizeBytes > ARTIFACT_DOCUMENT_LIMIT)) return null;
  if ([base, theirs, mine].some((side) => side && side.kind !== "text")) return null;
  const text = async (side?: ArtifactFileRow) => {
    if (!side) return "";
    const bytes = await blobs.read(workspaceId, side.sha256);
    if (!bytes) throw new AppError("CONFLICT", { errorId: "artifact-base-missing" });
    return new TextDecoder().decode(bytes);
  };
  const merge = mergeText(await text(base), await text(mine), await text(theirs));
  if ("chunks" in merge) return merge;
  const bytes = new TextEncoder().encode(merge.text) as Uint8Array<ArrayBuffer>;
  if (bytes.length > ARTIFACT_DOCUMENT_LIMIT) tooLarge();
  // Stored apart from the save's transaction: if the save then fails, the blob is one no version
  // names, which the sweep removes a day later with its object.
  const stored = await blobs.upload({ workspaceId, bytes });
  return { path: mine.path, ...stored };
}

function tooLarge(): never {
  throw new AppError("INVALID_INPUT", { errorId: "artifact-file-too-large" });
}
