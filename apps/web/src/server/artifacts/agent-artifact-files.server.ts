import { ARTIFACT_SHA256_PATTERN, ARTIFACT_UPLOAD_MAX_BYTES } from "@lrm/coforge-sdk/agent";
import { artifactInputs } from "#src/features/artifacts/artifact-inputs";
import { AppError } from "#src/lib/app-error";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import { agentErrorResponse } from "#src/server/agents/agent-http-middleware.server";
import { artifactsDisabled } from "./artifact-access.server";
import { ArtifactStorageFull, type StoredArtifactBlobs } from "./artifact-blobs.server";
import { artifactKindOfPath } from "./artifact-files.server";
import type { Artifacts } from "./artifacts.server";

/** What the Agent API's file bytes run on; production's is `productionArtifacts(db)`. */
export type AgentArtifactFileServices = {
  artifacts: Pick<Artifacts, "reads">;
  blobs: Pick<StoredArtifactBlobs, "upload" | "open">;
  enabled: (workspaceId: string) => Promise<boolean>;
};

/** The bytes a Workspace may hold that no saved version names yet. */
export const ARTIFACT_UNREFERENCED_QUOTA_BYTES = 1024 * 1024 * 1024;

/**
 * `PUT /api/agent/v1/artifacts/uploads/:sha256`: one file's bytes, stored under their sha256 and
 * granted to the Agent, so a push can name them. Uploading bytes the Workspace already holds
 * answers the same 204. Refused before the body is read: no `Content-Length` (411) or a larger
 * file than a push takes (413); and once read, bytes that are not `sha256` (400), or that would
 * take the Workspace's unused bytes past the quota (413).
 */
export async function handleAgentArtifactUpload(
  request: Request,
  sha256: string,
  principal: { workspaceId: string; agentId: string },
  services: AgentArtifactFileServices,
): Promise<Response> {
  try {
    const { workspaceId, agentId } = principal;
    if (!(await services.enabled(workspaceId))) throw artifactsDisabled();
    if (!ARTIFACT_SHA256_PATTERN.test(sha256))
      throw new AppError("INVALID_INPUT", {
        errorId: "artifact-blob-sha256",
        hint: "the path names the file's sha256 as 64 lowercase hex characters",
      });
    const declared = request.headers.get("content-length");
    if (declared === null || !/^\d+$/.test(declared))
      return errorResponse("LENGTH_REQUIRED", "content-length is required", 411, false);
    if (Number(declared) > ARTIFACT_UPLOAD_MAX_BYTES) return tooLarge("the file is too large");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > ARTIFACT_UPLOAD_MAX_BYTES) return tooLarge("the file is too large");
    // The store hashes the bytes (400 when they are not `sha256`) and counts only bytes new to
    // the Workspace against the quota: a file it holds adds nothing.
    await services.blobs.upload({
      workspaceId,
      bytes,
      sha256,
      actor: { agentId },
      unreferencedQuotaBytes: ARTIFACT_UNREFERENCED_QUOTA_BYTES,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ArtifactStorageFull)
      return tooLarge("the Workspace holds too many uploaded files no version uses yet", true);
    return agentErrorResponse(error);
  }
}

const tooLarge = (message: string, quota = false) =>
  errorResponse(quota ? "ARTIFACT_STORAGE_FULL" : "PAYLOAD_TOO_LARGE", message, 413, false);

/**
 * `GET /api/agent/v1/artifacts/:artifact/files/:path?version=n`: one file of a version (the
 * current one by default) as the exact bytes stored. Whoever may read the artifact may read its
 * files, and one it may not read is `NOT_FOUND`, as `read` answers.
 */
export async function handleAgentArtifactDownload(
  request: Request,
  params: { artifact: string; path: string },
  principal: { workspaceId: string; agentId: string },
  services: AgentArtifactFileServices,
): Promise<Response> {
  try {
    const { workspaceId, agentId } = principal;
    if (!(await services.enabled(workspaceId))) throw artifactsDisabled();
    const requested = new URL(request.url).searchParams.get("version");
    if (requested !== null && !/^[1-9]\d{0,8}$/.test(requested))
      throw new AppError("INVALID_INPUT", {
        errorId: "artifact-request",
        hint: "version is not accepted",
      });
    if (!artifactInputs.id.safeParse(params.artifact).success) throw new AppError("NOT_FOUND");
    const file = await services.artifacts.reads.file({
      workspaceId,
      artifactId: params.artifact,
      reader: { agentId },
      path: params.path,
      ...(requested !== null ? { version: Number(requested) } : {}),
    });
    const bytes = file && (await services.blobs.open(workspaceId, file.sha256));
    if (!file || !bytes)
      throw new AppError("NOT_FOUND", {
        errorId: "artifact-file-not-found",
        hint: "the version has no such file: `coforge artifact read` lists its files",
      });
    return new Response(bytes.body, {
      headers: {
        "Content-Type": contentType(file.path, file.kind),
        "Content-Length": String(file.sizeBytes),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return agentErrorResponse(error);
  }
}

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
function contentType(path: string, kind: string): string {
  const known = TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  if (known) return known;
  return kind === "text" || artifactKindOfPath(path) === "text"
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}
