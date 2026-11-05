/**
 * A save that came back as a conflict (task #385): someone else changed the same place since the
 * version the save started from. A person does not resolve it (Frank, 11-05: no co-editing to
 * see, as Claude's artifacts have none): the save keeps the viewer's side of each conflict and
 * everything that merged, and goes again over `currentVersion`.
 */

/** A piece of the document that did not merge (the server's `ArtifactTextChunk`). */
export type ConflictChunk =
  | { ok: string }
  | { conflict: { base: string; mine: string; theirs: string } };

export type SettingConflict = {
  name: "title" | "description" | "entryPath";
  base: string | null;
  mine: string;
  theirs: string;
};

/** The server's conflict answer, as a document reads it. */
export type DocumentConflict = {
  currentVersion: number;
  files: { path: string; chunks: ConflictChunk[] }[];
  settings: SettingConflict[];
};

/**
 * The save to send again: the merged text with the viewer's side wherever both changed it, and
 * the viewer's value of each setting both changed, over the version that has the other side. The
 * document's file is `entryPath` when the answer names it, else its only file.
 */
export function keepingMine(answer: DocumentConflict, entryPath: string) {
  const file = answer.files.find((each) => each.path === entryPath) ?? answer.files[0];
  const text = (file?.chunks ?? [])
    .map((chunk) => ("ok" in chunk ? chunk.ok : chunk.conflict.mine))
    .join("");
  const settings: Partial<Record<SettingConflict["name"], string>> = {};
  for (const setting of answer.settings) settings[setting.name] = setting.mine;
  return { baseVersion: answer.currentVersion, text, settings };
}
