import {
  ARTIFACT_SHA256_PATTERN,
  ARTIFACT_UPLOAD_MAX_BYTES,
  artifactPathValid,
} from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import { agentErrorResponse } from "#src/server/agents/agent-http-middleware.server";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import { admitArtifactUpload, ArtifactRateLimited } from "./agent-artifact-rate-limit.server";
import { type ArtifactActor } from "./artifact-access.server";
import { resolveArtifactReference } from "./artifact-reference.server";
import { ArtifactStorageFull, type StoredArtifactBlobs } from "./artifact-blobs.server";
import { artifactContentType } from "./artifact-content-types.server";
import type { Artifacts } from "./artifacts.server";

export type AgentArtifactFileServices = {
  artifacts: Pick<Artifacts, "reads">;
  blobs: Pick<StoredArtifactBlobs, "upload" | "open">;
  readActor?: ArtifactActor | undefined;
  uploadLimit?: AppRateLimit | undefined;
};

const REFERENCE_MAX_CHARS = 2000;

export const ARTIFACT_UNREFERENCED_QUOTA_BYTES = 1024 * 1024 * 1024;

export async function handleAgentArtifactUpload(
  request: Request,
  sha256: string,
  principal: { workspaceId: string; agentId: string },
  services: AgentArtifactFileServices,
): Promise<Response> {
  try {
    const { workspaceId, agentId } = principal;
    await admitArtifactUpload(services.uploadLimit, agentId);
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
    await services.blobs.upload({
      workspaceId,
      bytes,
      sha256,
      actor: { agentId },
      unreferencedQuotaBytes: ARTIFACT_UNREFERENCED_QUOTA_BYTES,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof ArtifactRateLimited) return error.response();
    if (error instanceof ArtifactStorageFull)
      return tooLarge("the Workspace holds too many uploaded files no version uses yet", true);
    return agentErrorResponse(error);
  }
}

const tooLarge = (message: string, quota = false) =>
  errorResponse(quota ? "ARTIFACT_STORAGE_FULL" : "PAYLOAD_TOO_LARGE", message, 413, false);

export async function handleAgentArtifactDownload(
  request: Request,
  params: { artifact: string; path: string },
  principal: { workspaceId: string; agentId: string },
  services: AgentArtifactFileServices,
): Promise<Response> {
  try {
    const { workspaceId, agentId } = principal;
    const requested = new URL(request.url).searchParams.get("version");
    if (requested !== null && !/^[1-9]\d{0,8}$/.test(requested))
      throw new AppError("INVALID_INPUT", {
        errorId: "artifact-request",
        hint: "version is not accepted",
      });
    if (!artifactPathValid(params.path) || params.artifact.length > REFERENCE_MAX_CHARS)
      throw new AppError("NOT_FOUND");
    const reader = services.readActor ?? { agentId };
    const reference = await resolveArtifactReference(
      params.artifact,
      async (title) =>
        (await services.artifacts.reads.listPage({ workspaceId, reader, title, limit: 6 }))
          .artifacts,
    );
    const version = requested !== null ? Number(requested) : reference.version;
    const file = await services.artifacts.reads.file({
      workspaceId,
      artifactId: reference.artifactId,
      reader,
      path: params.path,
      ...(version !== undefined ? { version } : {}),
    });
    const bytes = file && (await services.blobs.open(workspaceId, file.sha256));
    if (!file || !bytes)
      throw new AppError("NOT_FOUND", {
        errorId: "artifact-file-not-found",
        hint: "the version has no such file: `coforge artifact read` lists its files",
      });
    return new Response(bytes.body, {
      headers: {
        "Content-Type": artifactContentType(file.path, file.kind),
        "Content-Length": String(file.sizeBytes),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
