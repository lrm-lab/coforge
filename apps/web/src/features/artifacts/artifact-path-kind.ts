/** What a file is, from its extension. An artifact's type is its entry file's kind: no column
 * holds it, and the client cannot choose it. */
export type ArtifactPathKind =
  | "html"
  | "markdown"
  | "text"
  | "csv"
  | "image"
  | "pdf"
  | "video"
  | "other";

export function artifactKindOfPath(path: string): ArtifactPathKind {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (["html", "htm"].includes(extension)) return "html";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["txt", "tsv", "css", "js", "mjs", "yaml", "yml", "json", "xml"].includes(extension))
    return "text";
  if (extension === "csv") return "csv";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "svg"].includes(extension))
    return "image";
  if (extension === "pdf") return "pdf";
  if (["mp4", "webm", "mov"].includes(extension)) return "video";
  return "other";
}

/** The kinds an artifact's entry file may open as: a document or a web page. */
export type ArtifactOpenableKind = Extract<ArtifactPathKind, "markdown" | "html">;

/** The page an artifact's entry file opens as — `"markdown"` or `"html"` — or null when the
 * entry opens as neither, which no artifact's entry may be (`requireOpenableEntry` refuses it). */
export function artifactOpenableKind(path: string): ArtifactOpenableKind | null {
  const kind = artifactKindOfPath(path);
  return kind === "markdown" || kind === "html" ? kind : null;
}

/** Whether an artifact whose entry file is `entryPath` is a web page (an html entry); any other
 * artifact the page shows is a document. */
export const isWebPageEntry = (entryPath: string) => artifactOpenableKind(entryPath) === "html";
