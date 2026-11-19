import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  artifactPath,
  folderName,
  localChanges,
  pullTarget,
  refuseCaseCollisions,
  removeInside,
  shellWord,
  writeState,
  type LocalChanges,
} from "#src/artifact-directory";
import type {
  ArtifactDirectoryDraft,
  ArtifactDirectoryInvocation,
  ArtifactDirectoryTransport,
} from "#src/artifact-directory-args";
import { formatUnseen, formatUnseenComments } from "#src/artifact-unseen-format";
import type { ArtifactReadAnswer } from "#src/artifact-format";
import { asJson, pullFile, requireCall } from "#src/artifact-transfer";
import { CliError, invalidArg } from "#src/cli-error";
import { inPool } from "#src/pool";

const listPaths = (paths: readonly string[]) =>
  paths.length <= 5
    ? paths.join(", ")
    : `${paths.slice(0, 5).join(", ")} (+${paths.length - 5} more)`;

function formatLocalChanges(changes: LocalChanges): string {
  return [
    ...(changes.modified.length > 0 ? [`modified: ${listPaths(changes.modified)}`] : []),
    ...(changes.added.length > 0 ? [`added: ${listPaths(changes.added)}`] : []),
    ...(changes.deleted.length > 0 ? [`deleted: ${listPaths(changes.deleted)}`] : []),
  ].join("; ");
}

export async function runPull(
  invocation: ArtifactDirectoryInvocation,
  draft: Extract<ArtifactDirectoryDraft, { operation: "pull" }>,
  transport: ArtifactDirectoryTransport,
  cwd: string,
): Promise<unknown> {
  const answer = (await requireCall(
    transport.artifact,
    "request",
  )({
    operation: "read",
    artifact: draft.artifact,
    ...(draft.rev === undefined ? {} : { version: draft.rev }),
  })) as ArtifactReadAnswer;
  if (!answer.version) throw invalidArg("The artifact has no versions to pull");
  if (!answer.files)
    throw new CliError({
      code: "ARTIFACT_FAILED",
      message: "The server did not list the version's files, so it cannot be pulled",
      retryable: false,
    });
  const { id, title, currentVersion } = answer.artifact;
  const version = answer.version.number;
  const files = answer.files.map((file) => ({ ...file, path: artifactPath(file.path) }));
  refuseCaseCollisions(files.map((file) => file.path));
  const shown = draft.dir ?? folderName(title, id);
  const dir = resolve(cwd, shown);
  const previous = await pullTarget(dir, id);
  if (previous && previous.version > 0) {
    const changes = await localChanges(
      dir,
      previous,
      files.map((file) => file.path),
    );
    const summary = formatLocalChanges(changes);
    if (summary)
      throw new CliError({
        code: "ARTIFACT_DIR_CONFLICT",
        message: `${shown} has uncommitted local changes (${summary}); pulling would overwrite them.`,
        retryable: false,
        suggestedNextAction: `Push them first (coforge artifact push ${shellWord(shown)}), or pull into a fresh directory (coforge artifact pull ${id} --dir <new dir>).`,
        details: changes,
      });
  }
  await mkdir(dir, { recursive: true });
  await writeState(dir, {
    artifact: id,
    version: 0,
    files: {
      ...previous?.files,
      ...Object.fromEntries(files.map((file) => [file.path, file.sha256])),
    },
  });
  await inPool(files, 4, (file) => pullFile(transport, dir, id, version, file));
  const keep = new Set(files.map((file) => file.path));
  for (const path of Object.keys(previous?.files ?? {}))
    if (!keep.has(path)) await removeInside(dir, path);
  await writeState(dir, {
    artifact: id,
    version,
    files: Object.fromEntries(files.map((file) => [file.path, file.sha256])),
  });
  const lines = [
    `Pulled ${files.length} file${files.length === 1 ? "" : "s"} of "${title}" (id ${id}), version ${version} of ${currentVersion}, into ${shown}.`,
    ...(answer.entryPath ? [`Entry: ${answer.entryPath}`] : []),
    `Edit the files there, then send what changed: coforge artifact push ${shellWord(shown)}`,
    ...(answer.unseen ? formatUnseen(answer.unseen) : []),
    ...formatUnseenComments(id, answer.unseenComments),
  ];
  return asJson(
    invocation,
    {
      artifact: id,
      title,
      version,
      currentVersion,
      directory: dir,
      entryPath: answer.entryPath ?? null,
      files,
    },
    lines.join("\n"),
  );
}
