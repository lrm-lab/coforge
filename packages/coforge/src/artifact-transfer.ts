import { sha256Hex, writeInside } from "#src/artifact-directory";
import type {
  ArtifactDirectoryInvocation,
  ArtifactDirectoryTransport,
} from "#src/artifact-directory-args";
import { CliError } from "#src/cli-error";

export const requireCall = <T>(call: T | undefined, what: string): T => {
  if (!call) throw new Error(`Artifact ${what} transport is unavailable`);
  return call;
};

export const asJson = (invocation: ArtifactDirectoryInvocation, value: unknown, text: string) =>
  invocation.json === true ? value : text;

/**
 * One file of a version, downloaded and written into `dir` once its sha256 is what the version
 * lists for it.
 */
export async function pullFile(
  transport: ArtifactDirectoryTransport,
  dir: string,
  artifact: string,
  version: number,
  file: { path: string; sha256: string },
): Promise<void> {
  const bytes = await requireCall(
    transport.artifactDownload,
    "download",
  )({ artifact, path: file.path, version });
  if (sha256Hex(bytes) !== file.sha256)
    throw new CliError({
      code: "ARTIFACT_FILE_CORRUPT",
      message: `${file.path} did not arrive as the version holds it (its sha256 differs)`,
      retryable: true,
      suggestedNextAction: "Pull again.",
    });
  await writeInside(dir, file.path, bytes);
}
