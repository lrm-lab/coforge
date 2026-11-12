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
};

/** How many files `read` lists unless asked for all. */
const READ_FILES_SHOWN = 10;

/** A list answer: the rows alone, or a page of them with the cursor of the next one. */
type ListAnswer = ListRow[] | { artifacts: ListRow[]; nextCursor?: string | null };

type HistoryPage = {
  versions: {
    number: number;
    createdAt: string;
    publisher: { userId: string } | { agentId: string } | null;
    note: string | null;
    label: string | null;
    merged: boolean;
    revertedFrom: number | null;
  }[];
  nextBefore: number | null;
};

export type ArtifactSaveAnswer =
  | { status: "created"; number: number; merged: string[]; mergedSettings: string[] }
  | { status: "replayed"; number: number }
  | { status: "nothing" }
  | { status: "missing"; missing: string[] };

const readCommand = (id: string) => `coforge artifact read ${id}`;
const pushCommand = (id: string, base: number) =>
  `coforge artifact push ${id} --base ${base} --file <path>`;

export function formatArtifactCreated(card: Card): string {
  return [
    `Created artifact "${card.title}" (id ${card.id}, name ${card.name}), version ${card.currentVersion}.`,
    `Read it: ${readCommand(card.id)}`,
    `Save over it: ${pushCommand(card.id, card.currentVersion)}`,
  ].join("\n");
}

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

/** The artifact's version line and how to save over it; then its text, unless it went to a
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
    `Save over it: ${pushCommand(artifact.id, shown)}`,
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
  if (withText) lines.push("---", read.text);
  return lines.join("\n");
}

export function formatArtifactHistory(id: string, page: HistoryPage): string {
  if (page.versions.length === 0) return "No versions yet.";
  const lines = page.versions.map((version) => {
    const who = !version.publisher
      ? "someone removed"
      : "agentId" in version.publisher
        ? `agent ${version.publisher.agentId}`
        : `user ${version.publisher.userId}`;
    const marks = [
      version.label ? `label "${version.label}"` : "",
      version.merged ? "merged" : "",
      version.revertedFrom !== null ? `went back to version ${version.revertedFrom}` : "",
    ].filter(Boolean);
    return `version ${version.number}  ${version.createdAt}  ${who}${marks.length ? `  (${marks.join(", ")})` : ""}${version.note ? `\n  ${version.note}` : ""}`;
  });
  if (page.nextBefore !== null)
    lines.push(`Older: coforge artifact history ${id} --before ${page.nextBefore}`);
  return lines.join("\n");
}

/** A save's answer. An Agent's save is never merged inside a file: a clash is refused by the
 * server (`artifact-agent-base-moved`), never answered here. */
export function formatArtifactSave(
  base: number,
  answer: ArtifactSaveAnswer,
): { message: string; next?: string } {
  switch (answer.status) {
    case "created": {
      const merged = [...answer.merged, ...answer.mergedSettings];
      return {
        message: `Saved version ${answer.number}.${merged.length ? ` Merged with what others saved since version ${base}: ${merged.join(", ")}. Read it again before the next save.` : ""}`,
      };
    }
    case "replayed":
      return { message: `Already saved as version ${answer.number}.` };
    case "nothing":
      return { message: `Nothing to save: nothing differs from version ${base}.` };
    case "missing":
      return {
        message: "The server no longer has the bytes this save names; nothing was written.",
        next: "Save again.",
      };
  }
}
