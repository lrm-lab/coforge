import { AppError } from "#src/lib/app-error";
import {
  ARTIFACT_FILE_LIMIT,
  ARTIFACT_HTML_ENTRY,
  artifactKindOfPath,
  artifactPathValid,
  type ArtifactFileInput,
} from "./artifact-files.server";

/**
 * An Agent's version sent as a manifest instead of one text: the files it adds or replaces (by
 * the sha256 of bytes uploaded before), the paths it deletes, and the file the artifact opens at.
 */
export type FileManifest = {
  files?: readonly ArtifactFileInput[];
  deletedPaths?: readonly string[];
  entryPath?: string;
};

type ManifestKind = "markdown" | "html";

function invalid(errorId: string, hint?: string): never {
  throw new AppError("INVALID_INPUT", { errorId, ...(hint ? { hint } : {}) });
}

/** The kind of artifact an entry file makes: Markdown for `.md`/`.markdown`, a web page for
 * `.html`/`.htm`; any other file is not one an artifact opens at. */
export function manifestKind(entryPath: string): ManifestKind {
  const kind = artifactKindOfPath(entryPath);
  if (kind === "markdown" || kind === "html") return kind;
  return invalid("artifact-kind", "the entry file is a .md or .html file");
}

/**
 * What a manifest makes of a new artifact: its files, its entry (the manifest's own, else
 * `index.html` when it has one, else its only file) and the kind that entry's extension gives,
 * which a stated `kind` must match. A new artifact has nothing to delete.
 */
export function planManifestCreate(manifest: FileManifest, kind?: string) {
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
  const derived = manifestKind(entryPath);
  if (kind !== undefined && kind !== derived)
    invalid("artifact-kind", `the entry file ${entryPath} makes a ${derived} artifact`);
  return { files, entryPath, kind: derived };
}

const pathValid = (file: ArtifactFileInput) => artifactPathValid(file.path);
