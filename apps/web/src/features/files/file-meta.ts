import { extensionToLanguage, getPreviewKind } from "./preview";

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

export function getFileExtension(filename: string): string {
  const base = (filename ?? "").toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1);
}

export function fileTypeLabel(fileName: string, contentType: string): string | undefined {
  const suffix = getFileExtension(fileName);
  if (suffix && suffix.length <= 8 && !suffix.includes(" ")) return suffix.toUpperCase();
  const subtype = contentType.split(";")[0]?.split("/")[1]?.trim() ?? "";
  const named = subtype.replace(/^(x-|vnd\.)/, "");
  if (!named || named === "octet-stream") return undefined;
  return named.slice(0, 12).toUpperCase();
}

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

export function getReadableFileSize(bytes: number): string {
  if (bytes === 0) return "0 KB";
  const suffixes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.floor(bytes / 1024 ** index)} ${suffixes[index]}`;
}

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

  const language = extensionToLanguage(filename);
  if (language && language !== "plaintext" && language !== "markdown") {
    return "code";
  }
  if (kind === "markdown" || kind === "text") return "text";
  return "file";
}
