/**
 * A save that came back as a conflict (task #385, step 3), as the page resolves it: the
 * document's text in pieces, each conflict picked as the viewer's side, the latest version's, or
 * the viewer's own rewrite, and the settings (the title) likewise. Joined in order, the picks are
 * the text saved again over `currentVersion`.
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

/** One conflict's pick: a side, or text the viewer wrote from both. */
export type ConflictChoice = "mine" | "theirs" | { own: string };

/** What is being resolved: the document's chunks, its setting conflicts, and a pick for each
 * (text conflicts in order, then settings by name). */
export type ConflictResolution = {
  currentVersion: number;
  chunks: ConflictChunk[];
  settings: SettingConflict[];
  textChoices: (ConflictChoice | undefined)[];
  settingChoices: Partial<Record<SettingConflict["name"], ConflictChoice>>;
};

type TextConflict = Extract<ConflictChunk, { conflict: unknown }>["conflict"];

/**
 * The resolution of a conflict answer. `previous` is what the viewer had picked for the answer
 * before (a save of the picks that came back as a conflict again). That save sent each pick's
 * text as the viewer's side, so a new conflict whose `mine` is the text of an earlier pick is
 * that place again: it keeps the pick (as the viewer's side, or the same own rewrite), and
 * nobody picks twice what they already decided. The document's file is `entryPath` when the
 * answer names it, else its only file.
 */
export function resolutionOf(
  answer: DocumentConflict,
  entryPath: string,
  previous?: ConflictResolution,
): ConflictResolution {
  const file = answer.files.find((each) => each.path === entryPath) ?? answer.files[0];
  const chunks = file?.chunks ?? [];
  // Each earlier pick claims at most one new conflict, in document order.
  const picked = previous
    ? conflictsOf(previous.chunks).flatMap((conflict, index) => {
        const choice = previous.textChoices[index];
        return choice === undefined ? [] : [{ text: chosen(choice, conflict), choice }];
      })
    : [];
  const textChoices = conflictsOf(chunks).map((conflict) => {
    const index = picked.findIndex((each) => each.text === conflict.mine);
    if (index === -1) return undefined;
    const [{ choice }] = picked.splice(index, 1);
    return keptChoice(choice, conflict.mine);
  });
  const settingChoices: ConflictResolution["settingChoices"] = {};
  for (const setting of answer.settings) {
    const before = previous?.settings.find((each) => each.name === setting.name);
    const choice = before && previous!.settingChoices[before.name];
    if (choice && chosen(choice, before) === setting.mine)
      settingChoices[setting.name] = keptChoice(choice, setting.mine);
  }
  return {
    currentVersion: answer.currentVersion,
    chunks,
    settings: answer.settings,
    textChoices,
    settingChoices,
  };
}

const chosen = (choice: ConflictChoice, sides: { mine: string; theirs: string }) =>
  typeof choice === "string" ? sides[choice] : choice.own;

/** An earlier pick on the place it came back as: its text is now the viewer's side; an own
 * rewrite stays one, so its box stays open. */
const keptChoice = (choice: ConflictChoice, mine: string): ConflictChoice =>
  typeof choice === "string" ? "mine" : { own: mine };

/** The text conflicts, in document order. */
export function conflictsOf(chunks: readonly ConflictChunk[]): TextConflict[] {
  return chunks.flatMap((chunk) => ("conflict" in chunk ? [chunk.conflict] : []));
}

/** How many conflicts there are and how many are picked. */
export function conflictProgress(resolution: ConflictResolution) {
  const count = resolution.textChoices.length + resolution.settings.length;
  const picked =
    resolution.textChoices.filter((choice) => choice !== undefined).length +
    resolution.settings.filter((setting) => resolution.settingChoices[setting.name]).length;
  return { count, picked, done: picked === count };
}

/** The document's text with every conflict picked, or null while one is not. */
export function resolvedText(resolution: ConflictResolution): string | null {
  let index = 0;
  let text = "";
  for (const chunk of resolution.chunks) {
    if ("ok" in chunk) {
      text += chunk.ok;
      continue;
    }
    const choice = resolution.textChoices[index];
    index += 1;
    if (choice === undefined) return null;
    text += chosen(choice, chunk.conflict);
  }
  return text;
}

/** The picked value of each conflicting setting; only once all of them are picked. */
export function resolvedSettings(
  resolution: ConflictResolution,
): Partial<Record<SettingConflict["name"], string>> | null {
  const values: Partial<Record<SettingConflict["name"], string>> = {};
  for (const setting of resolution.settings) {
    const choice = resolution.settingChoices[setting.name];
    if (!choice) return null;
    values[setting.name] = chosen(choice, setting);
  }
  return values;
}

/** The text an "edit myself" box starts from: both sides, the viewer's first. */
export function ownDraft(sides: { mine: string; theirs: string }): string {
  if (!sides.mine.trim()) return sides.theirs;
  if (!sides.theirs.trim()) return sides.mine;
  const mine = sides.mine.endsWith("\n") ? sides.mine : `${sides.mine}\n`;
  return `${mine}${sides.theirs}`;
}
