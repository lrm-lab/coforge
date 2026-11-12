import { sha256Hex, writeInside } from "#src/artifact-directory";
import type { ArtifactDirectoryInvocation } from "#src/artifact-directory-args";
import { CliError } from "#src/cli-error";

export type FileEntry = { path: string; sha256: string; sizeBytes: number; kind?: string };
export type ReadAnswer = {
  artifact: { id: string; title: string; currentVersion: number };
  version: { number: number } | null;
  entryPath?: string | null;
  files?: FileEntry[];
};

export const requireCall = <T>(call: T | undefined, what: string): T => {
  if (!call) throw new Error(`Artifact ${what} transport is unavailable`);
  return call;
};

/** Runs `fn` over `items`, a few at a time, stopping at the first failure. */
export async function inPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

export const asJson = (invocation: ArtifactDirectoryInvocation, value: unknown, text: string) =>
  invocation.json === true ? value : text;

/**
 * One file of a version, downloaded and written into `dir` once its sha256 is what the version
 * lists for it.
 */
export async function pullFile(
  download: (request: { artifact: string; path: string; version?: number }) => Promise<Uint8Array>,
  dir: string,
  artifact: string,
  version: number,
  file: { path: string; sha256: string },
): Promise<void> {
  const bytes = await download({ artifact, path: file.path, version });
  if (sha256Hex(bytes) !== file.sha256)
    throw new CliError({
      code: "ARTIFACT_FILE_CORRUPT",
      message: `${file.path} did not arrive as the version holds it (its sha256 differs)`,
      retryable: true,
      suggestedNextAction: "Pull again.",
    });
  await writeInside(dir, file.path, bytes);
}
