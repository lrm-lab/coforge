import { AppError } from "#src/lib/app-error";
import type { ArtifactActor } from "./artifact-access.server";
import type { ArtifactReads } from "./artifact-reads.server";
import type { Artifacts } from "./artifacts.server";

export type ArtifactRevert = {
  workspaceId: string;
  artifactId: string;
  actor: ArtifactActor;
  to: number;
  baseVersion: number;
  idempotencyKey: string;
  note?: string;
};

/**
 * Goes back to version `to`: its files and settings saved as a new version, marked as going
 * back to it; no version is rewritten. `baseVersion` is the version the actor saw, which must
 * still be the current one: going back over a save made meanwhile is refused, not merged. Going
 * back to what is already there is nothing to save.
 */
export async function revertArtifact(
  reads: Pick<ArtifactReads, "read">,
  push: (save: Parameters<Artifacts["push"]>[0]) => ReturnType<Artifacts["push"]>,
  input: ArtifactRevert,
) {
  const { workspaceId, artifactId, actor } = input;
  const at = (version: number) => reads.read({ workspaceId, artifactId, reader: actor, version });
  const target = await at(input.to);
  const base = await at(input.baseVersion);
  if (!target.version || !base.version) throw new AppError("NOT_FOUND");
  const before = new Map(base.files.map((file) => [file.path, file.sha256]));
  const wanted = new Set(target.files.map((file) => file.path));
  return push({
    workspaceId,
    artifactId,
    baseVersion: input.baseVersion,
    exactBase: true,
    revertedFrom: input.to,
    publisher: actor,
    idempotencyKey: input.idempotencyKey,
    note: input.note ?? `Back to version ${input.to}`,
    files: target.files
      .filter((file) => before.get(file.path) !== file.sha256)
      .map(({ path, sha256 }) => ({ path, sha256 })),
    deletedPaths: [...before.keys()].filter((path) => !wanted.has(path)),
    title: target.version.title,
    description: target.version.description,
    entryPath: target.version.entryPath,
  });
}
