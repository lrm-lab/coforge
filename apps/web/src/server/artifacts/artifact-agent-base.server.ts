import { AppError } from "#src/lib/app-error";
import type { ArtifactFileInput, ArtifactFileRow } from "./artifact-files.server";
import type { ArtifactSettingConflict } from "./artifact-merge.server";

/**
 * A save over a version others moved past. What the others changed and the Agent's save
 * does not touch is kept (`Artifacts.push` merges by path); nothing is merged inside a file, and
 * what both sides changed refuses the whole save, naming it, so the Agent reads the newest
 * version and redoes its change on it.
 */

const REFUSAL = "artifact-base-moved";

/** The refusal of a save whose base is a version the artifact never had. */
export function refuseUnknownBase(): never {
  throw new AppError("CONFLICT", {
    errorId: REFUSAL,
    hint: "the base version is not one the artifact has; `coforge artifact pull` the newest version into a fresh directory, redo your change on it, then push again",
  });
}

/**
 * Refuses the save when both sides changed the same file or setting: a file the save adds or
 * deletes whose content now differs from what the save leaves there (so the same change on both
 * sides, or both deleting a file, is none), and a setting both changed to different values.
 * `details` carries them as one newline-separated string each: `files` (paths cannot hold a
 * newline) and `settings` (`title`, `description`, `entry`).
 */
export function refuseOverlap(input: {
  /** The paths whose content differs between the save's base and the current version. */
  changed: ReadonlySet<string>;
  current: ReadonlyMap<string, ArtifactFileRow>;
  added: readonly ArtifactFileInput[];
  deleted: readonly string[];
  settings: readonly ArtifactSettingConflict[];
}): void {
  const mine = new Map<string, string | undefined>([
    ...input.deleted.map((path) => [path, undefined] as const),
    ...input.added.map((file) => [file.path, file.sha256] as const),
  ]);
  const files = [...mine]
    .filter(([path, sha256]) => {
      return input.changed.has(path) && sha256 !== input.current.get(path)?.sha256;
    })
    .map(([path]) => path)
    .sort();
  const settings = input.settings.map(({ name }) => (name === "entryPath" ? "entry" : name));
  if (!files.length && !settings.length) return;
  const named = [...files, ...settings.map((name) => `the ${name}`)].join(", ");
  throw new AppError("CONFLICT", {
    errorId: REFUSAL,
    details: {
      ...(files.length && { files: files.join("\n") }),
      ...(settings.length && { settings: settings.join("\n") }),
    },
    hint: `others changed ${named} after you read the artifact; \`coforge artifact pull\` the newest version into a fresh directory, redo that change on it, then push again`,
  });
}
