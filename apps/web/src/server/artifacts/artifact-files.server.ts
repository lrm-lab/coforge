import { ARTIFACT_UPLOAD_MAX_BYTES } from "@lrm/coforge-sdk/agent";
import type { Prisma } from "#src/generated/prisma/client";

export { artifactPathValid } from "@lrm/coforge-sdk/agent";

export type ArtifactFileInput = {
  path: string;
  sha256: string;
};

export type ArtifactFileRow = { path: string; sha256: string; sizeBytes: number; kind: string };

export type ArtifactBlobInfo = { sizeBytes: number; kind: string };

export interface ArtifactBlobStore {
  inspectMany(
    workspaceId: string,
    sha256s: readonly string[],
  ): Promise<Map<string, ArtifactBlobInfo>>;
  use(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    sha256s: readonly string[],
  ): Promise<string[]>;
  allowed(
    workspaceId: string,
    artifactId: string | undefined,
    actor: { agentId: string },
    sha256s: readonly string[],
  ): Promise<Set<string>>;
  read(workspaceId: string, sha256: string): Promise<Uint8Array | null>;
}

export const ARTIFACT_TEXT_LIMIT = ARTIFACT_UPLOAD_MAX_BYTES;
export const ARTIFACT_BINARY_LIMIT = 15 * 1024 * 1024;
export const ARTIFACT_FILE_LIMIT = 200;
export const ARTIFACT_TITLE_MAX = 300;
export const ARTIFACT_HTML_ENTRY = "index.html";
export const ARTIFACT_ENTRY_READ_LIMIT = 2 * 1024 * 1024;
