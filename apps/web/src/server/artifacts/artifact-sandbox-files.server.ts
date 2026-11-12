import { artifactContentType } from "./artifact-content-types.server";
import { ARTIFACT_ENTRY_READ_LIMIT, artifactKindOfPath } from "./artifact-files.server";
import { SANDBOX_FILE_TTL_SECONDS } from "./artifact-sandbox-ticket.server";
import {
  sandboxFileHeaders,
  sandboxPageHeaders,
  withWebRtcOff,
} from "./artifact-sandbox-response.server";

/** A web page file (`.html`, `.htm`) at most, as an entry file the server reads (2 MiB): it is read
 * whole and a script put in front of it, which is not asked of the other files. */
export const ARTIFACT_HTML_LIMIT = ARTIFACT_ENTRY_READ_LIMIT;

/** Whether a path is a page of the artifact: a document the frame shows, not a subresource. */
export const isPageFile = (path: string) => artifactKindOfPath(path) === "html";

/** What a file request is for, from what the browser says about it. */
export type FileRequestUse = "frame" | "subresource";

/**
 * What a path may be asked for as: a page file (`.html`, `.htm`) is a frame, and so is a public
 * Markdown page's entry (`kind`); any other file is a subresource of a page.
 */
export const requiredUse = (path: string, kind: "html" | "markdown" = "html"): FileRequestUse =>
  kind === "markdown" || isPageFile(path) ? "frame" : "subresource";

/**
 * How long a browser keeps a page's other files. A signed link pins one version, so its files
 * never change under it: kept for the link's own file lifetime (and then at most that long beyond
 * it, which is as long as the reader had them open). A public link follows the current version, so
 * its files are kept for a minute. A page file and a wrapper are never kept: every load asks again
 * whether its reader may still read it.
 */
export const SIGNED_FILE_CACHE = `private, max-age=${SANDBOX_FILE_TTL_SECONDS}, immutable`;
export const PUBLIC_FILE_CACHE = "private, max-age=60";

/** What a page's script, style, image and media requests are (`Sec-Fetch-Dest`). */
const SUBRESOURCES = new Set(["script", "style", "image", "font", "audio", "video", "track"]);

/**
 * What a file request is, or null when it is neither a frame nor a subresource, so nothing is
 * served: never a top-level document (`document`), a fetch or XHR (`empty`; a page's CSP stops it
 * making one), or a request from a browser that sends no `Sec-Fetch-*`. A page's own subresources and the links it follows come
 * from its opaque origin, which a browser sends as `cross-site`; the wrapper's frame is
 * `same-origin`. Neither is `same-site` or `none`.
 */
export function fileRequestUse(headers: Headers): FileRequestUse | null {
  const site = headers.get("sec-fetch-site");
  if (site !== "same-origin" && site !== "cross-site") return null;
  const dest = headers.get("sec-fetch-dest");
  if (dest === "iframe") return "frame";
  return dest !== null && SUBRESOURCES.has(dest) ? "subresource" : null;
}

/**
 * One file of a page as the sandbox answers it. A page file gets the page's headers (its own
 * file prefix and the public hosts in its CSP) and WebRTC removed; any other file its type and a
 * policy that does nothing. Null when the bytes are gone, or a page file is over its limit.
 */
export function pageFileResponse(input: {
  method: string;
  path: string;
  bytes: Uint8Array | null;
  origins: { sandboxOrigin: string; appOrigin: string };
  filePrefix: string;
  /** `Cache-Control` of a file that is not a page file. */
  fileCache: string;
}): Response | null {
  const { bytes } = input;
  if (!bytes) return null;
  const page = isPageFile(input.path);
  if (page && bytes.byteLength > ARTIFACT_HTML_LIMIT) return null;
  const served = page ? withWebRtcOff(bytes) : bytes;
  const headers = page
    ? sandboxPageHeaders({ ...input.origins, filePrefix: input.filePrefix })
    : sandboxFileHeaders(
        artifactContentType(input.path, "other"),
        served.byteLength,
        input.fileCache,
      );
  headers.set("Content-Length", String(served.byteLength));
  const body = input.method === "HEAD" ? null : new Blob([served as Uint8Array<ArrayBuffer>]);
  return new Response(body, { status: 200, headers });
}
