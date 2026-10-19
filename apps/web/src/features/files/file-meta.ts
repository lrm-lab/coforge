/**
 * file-meta — pure helpers for how a file is described: its extension, size, kind and type label.
 *
 * Dependency-free (no React, no i18n) so components and unit tests can import the extension /
 * size / type-category logic directly. The type-category token picks a file's glyph in
 * `file-icon-type.ts`.
 */

import { extensionToLanguage, getPreviewKind } from "./preview";

// File-type category token. `file-icon-type.ts` maps each one to a glyph.
export type FileTypeCategory =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "word"
  | "excel"
  | "ppt"
  | "archive"
  | "code"
  | "text"
  | "file";

const ARCHIVE_EXTS = new Set<string>(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"]);
const WORD_EXTS = new Set<string>(["doc", "docx", "rtf", "odt"]);
const EXCEL_EXTS = new Set<string>(["xls", "xlsx", "ods", "csv", "tsv"]);
const PPT_EXTS = new Set<string>(["ppt", "pptx", "odp", "key"]);

/** Lowercased extension without the dot (`"report.PDF"` → `"pdf"`). Empty when none. */
export function getFileExtension(filename: string): string {
  const base = (filename ?? "").toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1);
}

/**
 * The short kind shown before a file's size: its extension, or the media type when the name has no
 * usable one (`LICENSE`, `Dockerfile`, a dotfile) so such a file still says what it is rather than
 * showing a bare size. `application/octet-stream` is the upload default for "unknown", so it names
 * nothing, and a dotted phrase ("notes.final version") is not an extension.
 *
 * Not unit-tested: this is display text, and `docs/agents/testing.md` reserves UI verification for
 * a browser.
 */
export function fileTypeLabel(fileName: string, contentType: string): string | undefined {
  const suffix = getFileExtension(fileName);
  // A long tail is part of the name rather than an extension ("notes.final version").
  if (suffix && suffix.length <= 8 && !suffix.includes(" ")) return suffix.toUpperCase();
  const subtype = contentType.split(";")[0]?.split("/")[1]?.trim() ?? "";
  const named = subtype.replace(/^(x-|vnd\.)/, "");
  if (!named || named === "octet-stream") return undefined;
  return named.slice(0, 12).toUpperCase();
}

/**
 * Human-readable byte size (`1536` → `"1.5 KB"`). One decimal below 100,
 * whole numbers at/above 100 and for raw bytes. Empty string for
 * non-finite / negative input so callers can drop it from the meta line.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Coarse file-type bucket for a file's icon. Leans on the existing
 * preview-kind / language detection, then adds document/archive buckets that
 * preview doesn't distinguish. Falls back to `"file"` for unknown types.
 */
export function getFileTypeCategory(contentType: string, filename: string): FileTypeCategory {
  const kind = getPreviewKind(contentType, filename);
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (kind === "pdf") return "pdf";

  const ext = getFileExtension(filename);
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (WORD_EXTS.has(ext)) return "word";
  if (EXCEL_EXTS.has(ext)) return "excel";
  if (PPT_EXTS.has(ext)) return "ppt";

  // A recognized programming/markup language (but not plain prose / markdown)
  // reads as code; everything else text-like is plain text.
  const language = extensionToLanguage(filename);
  if (language && language !== "plaintext" && language !== "markdown") {
    return "code";
  }
  if (kind === "markdown" || kind === "text") return "text";

  return "file";
}
