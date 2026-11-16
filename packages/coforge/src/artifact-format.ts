import { formatTelling, type TellingAnswer } from "#src/artifact-follow-format";
import { foldUntrustedLine } from "@lrm/coforge-sdk/internal";
import {
  formatUnseen,
  formatUnseenComments,
  type ArtifactUnseen,
  type UnseenCommentsAnswer,
} from "#src/artifact-unseen-format";

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
  entryKind?: string;
  files?: ArtifactFileEntry[];
  text: string;
  /** What others pushed since the Agent last looked; null for an older version, absent from an
   * older server. */
  unseen?: ArtifactUnseen | null;
  /** The comments of others the Agent has not read, whichever version is shown; null when the
   * server could not say, absent from an older one. */
  unseenComments?: UnseenCommentsAnswer | null;
};

/** The server's answer to `move`. */
export type ArtifactMovedAnswer = {
  artifact: { id: string; title: string };
  from: string;
  to: string;
};

export type ArtifactDeletedAnswer = {
  artifact: { id: string; title: string };
  deleted: true;
};

export type ArtifactSavedAnswer = TellingAnswer & {
  artifact: { id: string; title: string; entryPath?: string };
  created: boolean;
  attachment: { id: string; fileName: string };
};

export function formatArtifactSaved(answer: ArtifactSavedAnswer): string {
  const { artifact, created, attachment } = answer;
  return [
    created
      ? `Saved attachment "${foldUntrustedLine(attachment.fileName)}" as artifact "${foldUntrustedLine(artifact.title)}" (id ${artifact.id}), version 1. Nothing was posted in the conversation.`
      : `Attachment "${foldUntrustedLine(attachment.fileName)}" was already saved as artifact "${foldUntrustedLine(artifact.title)}" (id ${artifact.id}): nothing was made.`,
    ...(created ? formatTelling(artifact.id, answer) : []),
    `Read it: ${readCommand(artifact.id)}`,
  ].join("\n");
}

export function formatArtifactMoved({ artifact }: ArtifactMovedAnswer): string {
  return [
    `Moved "${foldUntrustedLine(artifact.title)}" (id ${artifact.id}) to the Workspace: every member and every Agent of it can now see it, with its comments and every version.`,
    "Only a person can move it back to its conversation (Who can see, on its page); you cannot.",
  ].join("\n");
}

export function formatArtifactDeleted({ artifact }: ArtifactDeletedAnswer): string {
  return `Deleted "${foldUntrustedLine(artifact.title)}" (id ${artifact.id}) with every version and comment. No one can open it any more, and this cannot be undone.`;
}

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
    if (read.entryPath)
      lines.push(`Entry: ${read.entryPath}${read.entryKind ? ` (${read.entryKind})` : ""}`);
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
