import { artifactPathValid } from "./artifact-files.server";

/**
 * A file's path as it is written in a sandbox URL (`/a/<ticket>/page/<path>`): each segment
 * percent-encoded, so a page's relative references (`css/site.css`, `../` never leaving the
 * prefix) resolve inside its own artifact.
 */
export const sandboxFileUrlPath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

/**
 * The artifact path a URL's file part names, or null when it names none: decoded one segment at a
 * time (so an encoded `/` or `..` never reads as a separator or a step up), then checked as every
 * path an artifact can hold is. Null before any lookup is made. The path is the raw URL
 * pathname's tail: a `URL` has already collapsed a literal `..`, an encoded one reaches here.
 */
export function decodeSandboxFilePath(raw: string): string | null {
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded.includes("/")) return null;
    segments.push(decoded);
  }
  const path = segments.join("/");
  return artifactPathValid(path) ? path : null;
}
