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

export type ArtifactOpenableKind = Extract<ArtifactPathKind, "markdown" | "html">;

export function artifactOpenableKind(path: string): ArtifactOpenableKind | null {
  const kind = artifactKindOfPath(path);
  return kind === "markdown" || kind === "html" ? kind : null;
}
