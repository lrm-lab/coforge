import { artifactContentType } from "./artifact-content-types.server";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { ARTIFACT_ENTRY_READ_LIMIT } from "./artifact-files.server";
import { SANDBOX_FILE_TTL_SECONDS } from "./artifact-sandbox-ticket.server";
import { withPageRuntime } from "./artifact-page-runtime.server";
import { sandboxFileHeaders, sandboxPageHeaders } from "./artifact-sandbox-response.server";

export const ARTIFACT_HTML_LIMIT = ARTIFACT_ENTRY_READ_LIMIT;

export const isPageFile = (path: string) => artifactKindOfPath(path) === "html";

export const isPdfFile = (path: string) => artifactKindOfPath(path) === "pdf";

export const isPdfDocument = (path: string, use: FileRequestUse) =>
  use === "frame" && isPdfFile(path);

export type FileRequestUse = "frame" | "subresource";

export const requiredUse = (path: string, kind: "html" | "markdown" = "html"): FileRequestUse =>
  kind === "markdown" || isPageFile(path) ? "frame" : "subresource";

export const SIGNED_FILE_CACHE = `private, max-age=${SANDBOX_FILE_TTL_SECONDS}, immutable`;
export const PUBLIC_FILE_CACHE = "private, max-age=60";

const FRAMES = new Set(["iframe", "document"]);
const SUBRESOURCES = new Set([
  "script",
  "style",
  "image",
  "font",
  "audio",
  "video",
  "track",
  "empty",
  "worker",
  "sharedworker",
]);

export function fileRequestUse(headers: Headers): FileRequestUse | null {
  const dest = headers.get("sec-fetch-dest");
  if (dest === null) return null;
  if (FRAMES.has(dest)) return "frame";
  return SUBRESOURCES.has(dest) ? "subresource" : null;
}

export function pageFileResponse(input: {
  method: string;
  path: string;
  bytes: Uint8Array | null;
  use: FileRequestUse;
  pageOrigin: string;
  frameAncestor: string;
  hostOrigin: string | null;
  filePrefix: string;
  assetPrefix?: string;
  fileCache: string;
}): Response | null {
  const { bytes } = input;
  if (!bytes) return null;
  const page = isPageFile(input.path);
  if (page && bytes.byteLength > ARTIFACT_HTML_LIMIT) return null;
  const document = page && input.use === "frame";
  const pdf = isPdfDocument(input.path, input.use);
  const served = document ? withPageRuntime(bytes, input.hostOrigin) : bytes;
  const headers = document
    ? sandboxPageHeaders({
        pageOrigin: input.pageOrigin,
        frameAncestor: input.frameAncestor,
        filePrefix: input.filePrefix,
        assetPrefix: input.assetPrefix,
      })
    : sandboxFileHeaders(
        artifactContentType(input.path, "other"),
        served.byteLength,
        pdf ? "no-store" : input.fileCache,
        pdf ? `default-src 'none'; frame-ancestors ${input.frameAncestor}` : undefined,
      );
  headers.set("Content-Length", String(served.byteLength));
  const body = input.method === "HEAD" ? null : new Blob([served as Uint8Array<ArrayBuffer>]);
  return new Response(body, { status: 200, headers });
}
