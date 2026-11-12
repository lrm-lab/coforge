import { foldUntrustedLine, formatUtcTimestamp } from "@lrm/coforge-sdk/internal";
import { formatUnseenComments, type UnseenCommentsAnswer } from "#src/artifact-comment-format";
import { plural } from "#src/plural";

/** What `coforge artifact` prints (task #385). The shapes are the server's answers. */

type Card = { id: string; name: string; title: string; currentVersion: number };

/** A row `artifact list` prints: the card, with when it last changed. */
type ListRow = Card & { updatedAt: string };

/** One file of a version, as the server lists it. */
export type ArtifactFileEntry = { path: string; sha256: string; sizeBytes: number; kind?: string };

/** The server's answer to `read`. */
export type ArtifactReadAnswer = {
  artifact: { id: string; title: string; currentVersion: number };
  version: { number: number; note?: string | null; label?: string | null } | null;
  entryPath?: string | null;
  files?: ArtifactFileEntry[];
  text: string;
  /** What others pushed since the Agent last looked; null for an older version, absent from an
   * older server. */
  unseen?: ArtifactUnseen | null;
  /** The comments of others the Agent has not read, whichever version is shown; null when the
   * server could not say, absent from an older one. */
  unseenComments?: UnseenCommentsAnswer | null;
};

/** A version someone else pushed since the Agent's read position. */
type UnseenVersion = {
  number: number;
  publisher: { kind: "user" | "agent"; name: string };
  createdAt: string;
  note: string;
  label: string;
  /** The first paths it changed (at most ten) and how many it changed in all. */
  changedPaths: string[];
  changedCount: number;
};

type ArtifactUnseen = {
  firstRead: boolean;
  versionCount: number;
  versions: UnseenVersion[];
};

/** How many files `read` lists unless asked for all. */
const READ_FILES_SHOWN = 10;

/** A list answer: the rows alone, or a page of them with the cursor of the next one. */
type ListAnswer = ListRow[] | { artifacts: ListRow[]; nextCursor?: string | null };

const readCommand = (id: string) => `coforge artifact read ${id}`;

/** The readable artifacts of a home, newest first: one line each (title, id, version, when), how
 * to read one, and, when more exist, the command for the next page. */
export function formatArtifactList(
  answer: ListAnswer,
  nextPage?: (cursor: string) => string,
): string {
  const rows = Array.isArray(answer) ? answer : answer.artifacts;
  const cursor = Array.isArray(answer) ? undefined : answer.nextCursor;
  if (rows.length === 0) return "No artifacts here yet.";
  const lines = rows.map(
    (row) => `${row.updatedAt}  "${row.title}" (id ${row.id}), version ${row.currentVersion}`,
  );
  lines.push(`Read one: ${readCommand("<id>")}`);
  if (cursor && nextPage) lines.push(`More: ${nextPage(cursor)}`);
  return lines.join("\n");
}

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** The artifact's version line and its files; then the entry file's text, unless it went to a
 * file. */
export function formatArtifactRead(
  read: ArtifactReadAnswer,
  withText: boolean,
  allFiles = false,
): string {
  const { artifact, version } = read;
  const shown = version?.number ?? 0;
  const lines = [
    `Artifact "${artifact.title}" (id ${artifact.id}), version ${shown} of ${artifact.currentVersion}${version?.label ? `, labelled "${version.label}"` : ""}.`,
  ];
  const files = read.files ?? [];
  if (files.length > 0) {
    if (read.entryPath) lines.push(`Entry: ${read.entryPath}`);
    lines.push(`Files (${files.length}):`);
    for (const file of allFiles ? files : files.slice(0, READ_FILES_SHOWN))
      lines.push(`  ${file.path}  ${size(file.sizeBytes)}`);
    if (!allFiles && files.length > READ_FILES_SHOWN)
      lines.push(`  ${files.length - READ_FILES_SHOWN} more: add --files to list them all`);
    lines.push(`Work on them as files: coforge artifact pull ${artifact.id}`);
  }
  if (read.unseen) lines.push(...formatUnseen(read.unseen));
  lines.push(...formatUnseenComments(artifact.id, read.unseenComments));
  if (withText) lines.push("---", read.text);
  return lines.join("\n");
}

/** What `read` and `pull` print of `unseen`: a headline, one line per listed version, and how
 * many earlier ones the list leaves out. */
export function formatUnseen({
  firstRead,
  versionCount,
  versions: shown,
}: ArtifactUnseen): string[] {
  if (versionCount === 0)
    return [
      firstRead
        ? "Your first read of it: nothing from others to show."
        : "Nothing new since you last looked.",
    ];
  const earlier = versionCount - shown.length;
  return [
    firstRead
      ? `You haven't read it before: ${plural(versionCount, "version")} so far. The newest:`
      : `New since you last looked: ${plural(versionCount, "version")}`,
    ...shown.map(unseenLine),
    ...(earlier > 0 ? [`- … ${plural(earlier, "version")} earlier`] : []),
  ];
}

/** Paths a version line names before it says how many more. */
const CHANGED_SHOWN = 4;

function unseenLine(version: UnseenVersion): string {
  const said = foldUntrustedLine(version.note || version.label);
  const paths = version.changedPaths.map(foldUntrustedLine);
  const more = version.changedCount - CHANGED_SHOWN;
  const changed = paths.length
    ? ` (changed: ${paths.slice(0, CHANGED_SHOWN).join(", ")}${more > 0 ? `, +${more} more` : ""})`
    : "";
  return `- v${version.number} by ${foldUntrustedLine(version.publisher.name)}, ${formatUtcTimestamp(version.createdAt)}${said ? `: ${said}` : ""}${changed}`;
}
