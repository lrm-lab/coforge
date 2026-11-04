/** What `coforge artifact` prints (task #385). The shapes are the server's answers. */

type Card = { id: string; name: string; title: string; currentVersion: number };

/** A row `artifact list` prints: the card, with when it last changed. */
type ListRow = Card & { updatedAt: string };

type Read = {
  artifact: { id: string; title: string; currentVersion: number };
  version: { number: number; note?: string | null; label?: string | null } | null;
  text: string;
};

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

type Chunk = { ok: string } | { conflict: { base: string; mine: string; theirs: string } };

export type ArtifactSaveAnswer =
  | { status: "created"; number: number; merged: string[]; mergedSettings: string[] }
  | { status: "replayed"; number: number }
  | { status: "nothing" }
  | { status: "missing"; missing: string[] }
  | {
      status: "conflict";
      currentVersion: number;
      files: { path: string; chunks: Chunk[] }[];
      settings: { name: string; base: string | null; mine: string; theirs: string }[];
    };

const readCommand = (id: string) => `coforge artifact read ${id}`;
const pushCommand = (id: string, base: number) =>
  `coforge artifact push ${id} --base ${base} --file <path>`;

export function formatArtifactCreated(card: Card): string {
  return [
    `Created document "${card.title}" (id ${card.id}, name ${card.name}), version ${card.currentVersion}.`,
    `Read it: ${readCommand(card.id)}`,
    `Save over it: ${pushCommand(card.id, card.currentVersion)}`,
  ].join("\n");
}

/** The readable documents of a home, newest first: one line each (title, id, version, when), and
 * how to read one. */
export function formatArtifactList(rows: ListRow[]): string {
  if (rows.length === 0) return "No documents here yet.";
  const lines = rows.map(
    (row) => `${row.updatedAt}  "${row.title}" (id ${row.id}), version ${row.currentVersion}`,
  );
  lines.push(`Read one: ${readCommand("<id>")}`);
  return lines.join("\n");
}

/** The document's version line and how to save over it; then its text, unless it went to a
 * file. */
export function formatArtifactRead(read: Read, withText: boolean): string {
  const { artifact, version } = read;
  const shown = version?.number ?? 0;
  const lines = [
    `Document "${artifact.title}" (id ${artifact.id}), version ${shown} of ${artifact.currentVersion}${version?.label ? `, labelled "${version.label}"` : ""}.`,
    `Save over it: ${pushCommand(artifact.id, shown)}`,
  ];
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

/**
 * A save's answer. A conflict prints the document with git-style markers at each place both
 * sides changed (`stdout`, to edit and save again over `currentVersion`), and every setting
 * both changed.
 */
export function formatArtifactSave(
  id: string,
  base: number,
  answer: ArtifactSaveAnswer,
): { message: string; stdout?: string; next?: string } {
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
    case "conflict": {
      const current = answer.currentVersion;
      const settings = answer.settings.map(
        (setting) =>
          `  ${setting.name}: yours ${JSON.stringify(setting.mine)}, theirs ${JSON.stringify(setting.theirs)}${setting.base === null ? "" : `, before both ${JSON.stringify(setting.base)}`}`,
      );
      const files = answer.files.map((file) => file.chunks.map(markChunk).join(""));
      return {
        message: [
          `Conflict: version ${current} was saved since version ${base}, changing the same places. Nothing was written.`,
          ...(files.length
            ? [
                "The document is printed with <<<<<<< yours / ======= / >>>>>>> theirs at each conflict.",
              ]
            : []),
          ...(settings.length ? ["Settings both sides changed:", ...settings] : []),
        ].join("\n"),
        stdout: files.join("\n"),
        next: `Resolve each conflict (keep one side, or join them), then save over version ${current}: ${pushCommand(id, current)}`,
      };
    }
  }
}

function markChunk(chunk: Chunk): string {
  if ("ok" in chunk) return chunk.ok;
  const { mine, base, theirs } = chunk.conflict;
  const line = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);
  return `<<<<<<< yours\n${line(mine)}||||||| before both\n${line(base)}=======\n${line(theirs)}>>>>>>> theirs\n`;
}
