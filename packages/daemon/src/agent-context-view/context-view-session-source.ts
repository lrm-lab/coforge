import { isAbsolute, relative } from "node:path";

export type ContextViewTranscriptSource = { absolute: string; relative: string };

/** Reads the provider-neutral native session manager seam exposed by the built-in/Pi sessions. */
export function contextViewTranscriptSource(
  session: unknown,
  workspaceRoot: string,
): ContextViewTranscriptSource | undefined {
  if (!session || typeof session !== "object") return undefined;
  const value = session as Record<string, unknown>;
  const manager = value.sessionManager as { getSessionFile?(): string | undefined } | undefined;
  const candidates = [
    "contextViewRequestLogPath",
    "transcriptPath",
    "sessionFile",
    "path",
    "filePath",
  ].map((key) => value[key]);
  const managed = manager?.getSessionFile?.();
  if (managed) candidates.push(managed);
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !isAbsolute(candidate)) continue;
    const relativePath = relative(workspaceRoot, candidate);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
    return { absolute: candidate, relative: relativePath };
  }
  return undefined;
}
