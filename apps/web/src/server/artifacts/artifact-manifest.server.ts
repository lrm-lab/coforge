import { AppError } from "#src/lib/app-error";
import {
  ARTIFACT_FILE_LIMIT,
  ARTIFACT_HTML_ENTRY,
  artifactPathValid,
  type ArtifactFileInput,
} from "./artifact-files.server";

export type FileManifest = {
  files?: readonly ArtifactFileInput[];
  deletedPaths?: readonly string[];
  entryPath?: string;
};

function invalid(errorId: string, hint?: string): never {
  throw new AppError("INVALID_INPUT", { errorId, ...(hint ? { hint } : {}) });
}

export function planManifestCreate(manifest: FileManifest) {
  const files = manifest.files ?? [];
  if (manifest.deletedPaths?.length)
    invalid("artifact-file-path", "a new artifact has nothing to delete");
  if (files.length > ARTIFACT_FILE_LIMIT) invalid("artifact-too-many-files");
  if (new Set(files.map((file) => file.path)).size !== files.length || !files.every(pathValid))
    invalid("artifact-file-path");
  const entryPath =
    manifest.entryPath ??
    (files.some((file) => file.path === ARTIFACT_HTML_ENTRY)
      ? ARTIFACT_HTML_ENTRY
      : files.length === 1
        ? files[0]!.path
        : undefined);
  if (entryPath === undefined || !files.some((file) => file.path === entryPath))
    invalid(
      "artifact-entry-missing",
      `name the entry file among the files (entry), or send an ${ARTIFACT_HTML_ENTRY} or one file`,
    );
  return { files, entryPath };
}

const pathValid = (file: ArtifactFileInput) => artifactPathValid(file.path);
