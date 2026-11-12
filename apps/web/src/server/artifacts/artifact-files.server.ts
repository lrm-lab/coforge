import { ARTIFACT_UPLOAD_MAX_BYTES } from "@lrm/coforge-sdk/agent";
import type { Prisma } from "#src/generated/prisma/client";

export { artifactPathValid } from "@lrm/coforge-sdk/agent";
export { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";

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
   * ones the artifact already uses (none, before the artifact exists). Any other is answered as
   * missing, so the client uploads it. */
  allowed(
    workspaceId: string,
    artifactId: string | undefined,
    actor: { agentId: string },
    sha256s: readonly string[],
  ): Promise<Set<string>>;
  /** A stored blob's bytes, or null when the Workspace stores none under `sha256`. */
  read(workspaceId: string, sha256: string): Promise<Uint8Array | null>;
}

export const ARTIFACT_TEXT_LIMIT = ARTIFACT_UPLOAD_MAX_BYTES;
export const ARTIFACT_BINARY_LIMIT = 15 * 1024 * 1024;
export const ARTIFACT_FILE_LIMIT = 200;
/** The file a web page opens at unless it names another. */
export const ARTIFACT_HTML_ENTRY = "index.html";
/** The most of an entry file the server reads whole to show it: a web page's source, a rendered
 * Markdown, the card's preview. A larger entry is stored and served, but not read here. */
export const ARTIFACT_ENTRY_READ_LIMIT = 2 * 1024 * 1024;
