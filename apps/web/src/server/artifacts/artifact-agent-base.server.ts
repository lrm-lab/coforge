import { AppError } from "#src/lib/app-error";
import type { ArtifactFileInput, ArtifactFileRow } from "./artifact-files.server";
import type { ArtifactSettingConflict } from "./artifact-merge.server";

/**
 * An Agent's save over a version others moved past. What the others changed and the Agent's save
 * does not touch is kept (`Artifacts.push` merges by path); nothing is merged inside a file, and
 * what both sides changed refuses the whole save, naming it, so the Agent reads the newest
 * version and redoes its change on it.
 */

const REFUSAL = "artifact-agent-base-moved";

/** The refusal of a save the artifact moved past, where the save must be on the newest version. */
export function refuseMovedBase(publisher: { agentId?: string }): never {
  throw new AppError("CONFLICT", {
    errorId: publisher.agentId ? REFUSAL : "artifact-base-moved",
    hint: publisher.agentId
      ? "the artifact changed after you read it; run `coforge artifact read` for the newest version, then save again"
      : undefined,
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
  base: ReadonlyMap<string, ArtifactFileRow>;
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
      const theirs = input.current.get(path)?.sha256;
      return input.base.get(path)?.sha256 !== theirs && sha256 !== theirs;
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
    hint: `others changed ${named} after you read the artifact; run \`coforge artifact read\` for the newest version, redo that change on it, then save again`,
  });
}
