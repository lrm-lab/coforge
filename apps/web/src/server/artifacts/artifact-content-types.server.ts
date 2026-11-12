import { artifactKindOfPath } from "./artifact-files.server";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** A file's media type from its extension; any other text file is plain text, any other bytes
 * are a download. (`artifactKindOfPath` says which kind of file the extension names.) */
export function artifactContentType(path: string, kind: string): string {
  const known = TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  if (known) return known;
  return kind === "text" || artifactKindOfPath(path) === "text"
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}
