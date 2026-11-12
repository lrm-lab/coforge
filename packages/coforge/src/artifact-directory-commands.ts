import { basename, resolve } from "node:path";
import { artifactPath } from "#src/artifact-directory";
import type {
  ArtifactDirectoryDraft,
  ArtifactDirectoryInvocation,
  ArtifactDirectoryTransport,
} from "#src/artifact-directory-args";
import { runPull } from "#src/artifact-pull";
import { runPush } from "#src/artifact-push";
import { asJson, requireCall } from "#src/artifact-transfer";
import { CliError } from "#src/cli-error";

/**
 * `coforge artifact pull|push|download`: an artifact as a directory of files. A pull writes every
 * file of a version and a state file; a push sends the files whose sha256 differs from that state,
 * as a new version over the pulled one; a directory with no state creates a new artifact.
 */
export async function runArtifactDirectory(
  invocation: ArtifactDirectoryInvocation,
  transport: ArtifactDirectoryTransport,
  cwd = process.cwd(),
): Promise<unknown> {
  const draft = invocation.directory;
  try {
    switch (draft.operation) {
      case "pull":
        return await runPull(invocation, draft, transport, cwd);
      case "push":
        return await runPush(invocation, draft, transport, cwd);
      case "download":
        return await runDownload(invocation, draft, transport, cwd);
    }
  } catch (error) {
    throw error instanceof CliError && invocation.json
      ? new CliError({ ...cliErrorInit(error), outputMode: "json" })
      : error;
  }
}

function cliErrorInit(error: CliError) {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.suggestedNextAction ? { suggestedNextAction: error.suggestedNextAction } : {}),
    ...(error.correlationId ? { correlationId: error.correlationId } : {}),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

async function runDownload(
  invocation: ArtifactDirectoryInvocation,
  draft: Extract<ArtifactDirectoryDraft, { operation: "download" }>,
  transport: ArtifactDirectoryTransport,
  cwd: string,
): Promise<unknown> {
  const path = artifactPath(draft.path);
  const bytes = await requireCall(
    transport.artifactDownload,
    "download",
  )({
    artifact: draft.artifact,
    path,
    ...(draft.rev === undefined ? {} : { version: draft.rev }),
  });
  const output = resolve(cwd, draft.output ?? basename(path));
  await Bun.write(output, bytes);
  return asJson(
    invocation,
    { artifact: draft.artifact, path, output, sizeBytes: bytes.byteLength },
    `Saved ${path}${draft.rev === undefined ? "" : ` (version ${draft.rev})`}, ${bytes.byteLength} bytes, to ${output}.`,
  );
}
