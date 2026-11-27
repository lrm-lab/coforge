import { formatTelling, type TellingAnswer } from "#src/artifact-follow-format";
import { foldUntrustedLine } from "@lrm/coforge-sdk/internal";
import {
  formatUnseen,
  formatUnseenComments,
  type ArtifactUnseen,
  type UnseenCommentsAnswer,
} from "#src/artifact-unseen-format";

/** What `coforge artifact` prints (task #385). The shapes are the server's answers. */

type ArtifactSettledInfo = {
  at: string;
  version: number;
  by: { kind: string; name: string };
};

type ArtifactReopenedInfo = {
  version: number;
  was: ArtifactSettledInfo;
};

type Card = {
  id: string;
  name: string;
  title: string;
  currentVersion: number;
  settled?: ArtifactSettledInfo | null;
  reopened?: ArtifactReopenedInfo | null;
};

type ListRow = Card & { updatedAt: string };

export type ArtifactFileEntry = { path: string; sha256: string; sizeBytes: number; kind?: string };

export type ArtifactReadAnswer = {
  artifact: {
    id: string;
    title: string;
    currentVersion: number;
    settled?: ArtifactSettledInfo | null;
    reopened?: ArtifactReopenedInfo | null;
  };
  version: {
    number: number;
    note?: string | null;
    label?: string | null;
    publisher?: { kind: string; name: string } | null;
    createdAt?: string | null;
  } | null;
  url?: string | null;
  home?: string | null;
  origin?: { messageId: string; target?: string | null; threadRootId?: string | null } | null;
  viewing?: string[] | null;
  entryPath?: string | null;
  entryKind?: string;
  files?: ArtifactFileEntry[];
  text: string;
  unseen?: ArtifactUnseen | null;
  unseenComments?: UnseenCommentsAnswer | null;
};

export type ArtifactMovedAnswer = {
  artifact: { id: string; title: string };
  from: string;
  to: string;
  url?: string | null;
};

export type ArtifactDeletedAnswer = {
  artifact: { id: string; title: string };
  deleted: true;
};

export type ArtifactSettledAnswer = TellingAnswer & {
  artifact: {
    id: string;
    name: string;
    title: string;
    currentVersion: number;
    settled?: ArtifactSettledInfo | null;
    reopened?: ArtifactReopenedInfo | null;
  };
  changed: boolean;
};

function settledDay(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toISOString().slice(0, 10);
}

function settlementLine(artifact: {
  settled?: ArtifactSettledInfo | null;
  reopened?: ArtifactReopenedInfo | null;
}): string | null {
  if (artifact.settled) {
    const { by, at, version } = artifact.settled;
    return `Settled: @${foldUntrustedLine(by.name)} settled it on ${settledDay(at)} at v${version}. A new version takes it back to Working.`;
  }
  if (artifact.reopened) {
    const { version, was } = artifact.reopened;
    return `Working again: v${version} came after @${foldUntrustedLine(was.by.name)} settled v${was.version} on ${settledDay(was.at)}.`;
  }
  return null;
}

export function formatArtifactSettled(answer: ArtifactSettledAnswer, settling: boolean): string {
  const { artifact, changed } = answer;
  const title = foldUntrustedLine(artifact.title);
  const settled = artifact.settled ?? null;
  if (settling) {
    const version = settled?.version ?? artifact.currentVersion;
    const first = changed
      ? `Settled "${title}" at v${version}.`
      : `"${title}" was settled already${settled ? ` by @${foldUntrustedLine(settled.by.name)} on ${settledDay(settled.at)} at v${settled.version}` : ""}: nothing changed.`;
    return [first, ...(changed ? formatTelling(artifact.id, answer) : [])].join("\n");
  }
  return changed
    ? `"${title}" is Working again.`
    : `"${title}" is Working already: nothing changed.`;
}

export type ArtifactSavedAnswer = TellingAnswer & {
  artifact: { id: string; title: string; entryPath?: string };
  created: boolean;
  attachment: { id: string; fileName: string };
  url?: string | null;
};

export function formatArtifactSaved(answer: ArtifactSavedAnswer): string {
  const { artifact, created, attachment } = answer;
  return [
    created
      ? `Saved attachment "${foldUntrustedLine(attachment.fileName)}" as artifact "${foldUntrustedLine(artifact.title)}" (id ${artifact.id}), version 1. Nothing was posted in the conversation.`
      : `Attachment "${foldUntrustedLine(attachment.fileName)}" was already saved as artifact "${foldUntrustedLine(artifact.title)}" (id ${artifact.id}): nothing was made.`,
    ...(answer.url ? [`Open: ${answer.url}`] : []),
    ...(created ? formatTelling(artifact.id, answer) : []),
    `Read it: ${readCommand(artifact.id)}`,
  ].join("\n");
}

export function formatArtifactMoved({ artifact, url }: ArtifactMovedAnswer): string {
  return [
    `Moved "${foldUntrustedLine(artifact.title)}" (id ${artifact.id}) to the Workspace: every member and every Agent of it can now see it, with its comments and every version.`,
    ...(url ? [`Open: ${url}`] : []),
    "Only a person can move it back to its conversation (Who can see, on its page); you cannot.",
  ].join("\n");
}

export function formatArtifactDeleted({ artifact }: ArtifactDeletedAnswer): string {
  return `Deleted "${foldUntrustedLine(artifact.title)}" (id ${artifact.id}) with every version and comment. No one can open it any more, and this cannot be undone.`;
}

const READ_FILES_SHOWN = 10;

type ListAnswer = ListRow[] | { artifacts: ListRow[]; nextCursor?: string | null };

const readCommand = (id: string) => `coforge artifact read ${id}`;

export function formatArtifactList(
  answer: ListAnswer,
  nextPage?: (cursor: string) => string,
): string {
  const rows = Array.isArray(answer) ? answer : answer.artifacts;
  const cursor = Array.isArray(answer) ? undefined : answer.nextCursor;
  if (rows.length === 0) return "No artifacts here yet.";
  const lines = rows.map(
    (row) =>
      `${row.updatedAt}  "${row.title}" (id ${row.id}), version ${row.currentVersion}${row.settled ? " [settled]" : ""}`,
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

export function formatArtifactRead(
  read: ArtifactReadAnswer,
  withText: boolean,
  allFiles = false,
): string {
  const { artifact, version } = read;
  const shown = version?.number ?? 0;
  const publisher = version?.publisher?.name
    ? ` by ${foldUntrustedLine(version.publisher.name)}`
    : "";
  const publishedAt = version?.createdAt ? `, ${version.createdAt}` : "";
  const lines = [
    `Artifact "${artifact.title}" (id ${artifact.id}), version ${shown} of ${artifact.currentVersion}${version?.label ? `, labelled "${version.label}"` : ""}${publisher}${publishedAt}.`,
  ];
  if (read.url) lines.push(`Open: ${read.url}`);
  const statusLine = settlementLine(artifact);
  if (statusLine) lines.push(statusLine);
  if (read.home) lines.push(`Home: ${foldUntrustedLine(read.home)}`);
  if (read.origin)
    lines.push(
      `From: message ${read.origin.messageId}${read.origin.target ? ` in ${foldUntrustedLine(read.origin.target)}` : ""}`,
    );
  if (read.viewing && read.viewing.length > 0)
    lines.push(`Viewing now: ${read.viewing.map(foldUntrustedLine).join(", ")}`);
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
