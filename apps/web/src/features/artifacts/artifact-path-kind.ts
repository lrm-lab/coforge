/** What a file is, from its extension. An artifact's type is its entry file's kind: no column
 * holds it, and the client cannot choose it. */
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

/** Whether an artifact whose entry file is `entryPath` is a web page (an html entry); any other
 * artifact the page shows is a document. */
export const isWebPageEntry = (entryPath: string) => artifactKindOfPath(entryPath) === "html";
