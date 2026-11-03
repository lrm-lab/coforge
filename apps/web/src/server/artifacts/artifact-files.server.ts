import type { Prisma } from "#src/generated/prisma/client";

/** One file a push adds or replaces: bytes already uploaded under `sha256`. Its size and kind
 * come from the blob, never from the client. */
export type ArtifactFileInput = {
  path: string;
  sha256: string;
};

/** One file of a version, as stored. */
export type ArtifactFileRow = { path: string; sha256: string; sizeBytes: number; kind: string };

/** What a stored blob is: its size and the kind the server derived from the bytes. */
export type ArtifactBlobInfo = { sizeBytes: number; kind: string };

/** Content-addressed storage of artifact bytes, shared by every version. */
export interface ArtifactBlobStore {
  /** One lookup for every sha256 a push names; a blob that is not stored is absent. */
  inspectMany(
    workspaceId: string,
    sha256s: readonly string[],
  ): Promise<Map<string, ArtifactBlobInfo>>;
  /** Marks the blobs a save names as used, in the save's transaction; returns those no longer
   * stored. */
  use(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    sha256s: readonly string[],
  ): Promise<string[]>;
  /** Of `sha256s`, the ones `actor` may name in a save of `artifactId`: bytes it uploaded, or
   * ones the artifact already uses. Any other is answered as missing, so the client uploads it. */
  allowed(
    workspaceId: string,
    artifactId: string,
    actor: { userId?: string; agentId?: string },
    sha256s: readonly string[],
  ): Promise<Set<string>>;
  /** A stored blob's bytes, or null when the Workspace stores none under `sha256`. */
  read(workspaceId: string, sha256: string): Promise<Uint8Array | null>;
  /** Stores bytes the server made itself (a merged file), once, by their sha256. */
  upload(input: {
    workspaceId: string;
    bytes: Uint8Array<ArrayBuffer>;
  }): Promise<ArtifactBlobInfo & { sha256: string }>;
}

export const ARTIFACT_TEXT_LIMIT = 16 * 1024 * 1024;
export const ARTIFACT_BINARY_LIMIT = 15 * 1024 * 1024;
export const ARTIFACT_FILE_LIMIT = 200;
/** A document's (a `markdown` artifact's) own file: what a person edits in one page. */
export const ARTIFACT_DOCUMENT_LIMIT = 2 * 1024 * 1024;

/**
 * A file path as segments: no empty segment (`a//b`, a trailing `/`), no `.`/`..`, no backslash,
 * no control character, nothing absolute. `a..b.txt` is a normal name and passes.
 */
export function artifactPathValid(path: string): boolean {
  if (!path || path.startsWith("/") || path.endsWith("/")) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/[\\:\u0000-\u001f\u007f]/.test(segment),
    );
}

/** The server's own reading of a file's kind, from its extension; the client cannot choose it. */
export function artifactKindOfPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["html", "htm"].includes(extension)) return "html";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["txt", "log"].includes(extension)) return "text";
  if (extension === "csv") return "csv";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (["mp4", "webm", "mov"].includes(extension)) return "video";
  return "other";
}
