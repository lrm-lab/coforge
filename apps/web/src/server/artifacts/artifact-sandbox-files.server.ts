import { artifactContentType } from "./artifact-content-types.server";
import { ARTIFACT_DOCUMENT_LIMIT, artifactKindOfPath } from "./artifact-files.server";
import {
  sandboxFileHeaders,
  sandboxPageHeaders,
  withWebRtcOff,
} from "./artifact-sandbox-response.server";

/** A web page file (`.html`, `.htm`) at most, as a document (2 MiB): it is read whole and a script
 * put in front of it, which is not asked of the other files. */
export const ARTIFACT_HTML_LIMIT = ARTIFACT_DOCUMENT_LIMIT;

/** Whether a path is a page of the artifact: a document the frame shows, not a subresource. */
export const isPageFile = (path: string) => artifactKindOfPath(path) === "html";

/** What a file request is for, from what the browser says about it. */
export type FileRequestUse = "frame" | "subresource";

/** What a page's script, style, image and media requests are (`Sec-Fetch-Dest`). */
const SUBRESOURCES = new Set([
  "script",
  "style",
  "image",
  "font",
  "audio",
  "video",
  "track",
  "empty",
]);

/**
 * What a file request is, or null when it is neither a frame nor a subresource, so nothing is
 * served: never a top-level document (`document`), a frame of anyone else's, or a request from
 * a browser that sends no `Sec-Fetch-*`. A page's own subresources and the links it follows come
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
}): Response | null {
  const { bytes } = input;
  if (!bytes) return null;
  const page = isPageFile(input.path);
  if (page && bytes.byteLength > ARTIFACT_HTML_LIMIT) return null;
  const served = page ? withWebRtcOff(bytes) : bytes;
  const headers = page
    ? sandboxPageHeaders({ ...input.origins, filePrefix: input.filePrefix })
    : sandboxFileHeaders(artifactContentType(input.path, "other"), served.byteLength);
  headers.set("Content-Length", String(served.byteLength));
  const body = input.method === "HEAD" ? null : new Blob([served as Uint8Array<ArrayBuffer>]);
  return new Response(body, { status: 200, headers });
}
