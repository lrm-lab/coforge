// The package entry re-exports only `FileIcon`; the glyph list ships beside it in the same module,
// reachable because the package declares no `exports` map. An upgrade that adds one fails the build.
import { SUPPORTED_FILE_TYPES } from "@untitledui/file-icons/dist/FileIcon";

import { type FileTypeCategory, getFileExtension, getFileTypeCategory } from "./file-meta";

/** Glyphs the icon set draws for a kind of file, or as a variant, rather than for one extension. */
const CATEGORY_GLYPHS = new Set<(typeof SUPPORTED_FILE_TYPES)[number]>([
  "audio",
  "code",
  "document",
  "empty",
  "folder",
  "image",
  "img",
  "spreadsheets",
  "video",
  "video-01",
  "video-02",
  "pdf-simple",
]);

const EXTENSION_GLYPHS = new Set<string>(
  SUPPORTED_FILE_TYPES.filter((type) => !CATEGORY_GLYPHS.has(type)),
);

const CATEGORY_GLYPH: Record<FileTypeCategory, (typeof SUPPORTED_FILE_TYPES)[number]> = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "pdf",
  word: "document",
  excel: "spreadsheets",
  ppt: "document",
  archive: "empty",
  code: "code",
  text: "document",
  file: "empty",
};

/** The Untitled file-icon type for a file: its extension's own glyph when the set has one, else
 * the glyph for its kind. */
export function fileIconType(fileName: string, contentType = ""): string {
  const extension = getFileExtension(fileName);
  if (EXTENSION_GLYPHS.has(extension)) return extension;
  return CATEGORY_GLYPH[getFileTypeCategory(contentType, fileName)];
}
