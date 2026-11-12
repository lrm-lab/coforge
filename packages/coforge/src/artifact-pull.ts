import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  artifactPath,
  folderName,
  pullTarget,
  refuseCaseCollisions,
  removeInside,
  shellWord,
  writeState,
} from "#src/artifact-directory";
import type {
  ArtifactDirectoryDraft,
  ArtifactDirectoryInvocation,
  ArtifactDirectoryTransport,
} from "#src/artifact-directory-args";
import { formatUnseenComments } from "#src/artifact-comment-format";
import { formatUnseen, type ArtifactReadAnswer } from "#src/artifact-format";
import { asJson, pullFile, requireCall } from "#src/artifact-transfer";
import { CliError, invalidArg } from "#src/cli-error";
import { inPool } from "#src/pool";

/** `coforge artifact pull`: every file of a version into a directory, with its state file. */
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
  await mkdir(dir, { recursive: true });
  // Until the last file is in, the directory is a mix of versions: its state says so. It still
  // names every file either version may have left, so a later pull removes the ones dropped.
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
    // Pulling the current version moves the Agent's read position, as a read does.
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
