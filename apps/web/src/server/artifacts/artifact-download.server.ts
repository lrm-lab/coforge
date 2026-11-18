import { Zip, ZipPassThrough } from "fflate";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { ARTIFACT_ZIP_LIMIT_BYTES } from "#src/features/artifacts/artifact-zip-limit";
import { AppError } from "#src/lib/app-error";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import {
  IMMUTABLE_IMAGE_CACHE_CONTROL,
  PRIVATE_NO_STORE,
} from "#src/server/http/cache-control.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import { artifactContentType } from "./artifact-content-types.server";
import { artifactRateLimitedResponse } from "./artifact-rate-limited-response.server";
import type { ArtifactReads } from "./artifact-reads.server";

type Sources = {
  reads: Pick<ArtifactReads, "read">;
  blobs: Pick<StoredArtifactBlobs, "read" | "inspectMany">;
  zipLimit: AppRateLimit;
};

type Request = {
  workspaceId: string;
  artifactId: string;
  userId: string;
  version?: number;
  path?: string;
  limit?: number;
};

const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

export const artifactFileHeaders = (type: string, name: string, pinned = false) => ({
  "Content-Type": type,
  "Content-Disposition": attachment(name),
  "Cache-Control": pinned ? IMMUTABLE_IMAGE_CACHE_CONTROL : PRIVATE_NO_STORE,
  "X-Content-Type-Options": "nosniff",
});

export async function artifactDownload(sources: Sources, input: Request): Promise<Response> {
  const read = await sources.reads.read({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    reader: { userId: input.userId },
    version: input.version,
  });
  if (input.path !== undefined) {
    const file = read.files.find((entry) => entry.path === input.path);
    if (!file) throw new AppError("NOT_FOUND");
    const bytes = await sources.blobs.read(input.workspaceId, file.sha256);
    if (!bytes) throw new AppError("NOT_FOUND");
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: artifactFileHeaders(
        artifactContentType(file.path, file.kind),
        file.path.slice(file.path.lastIndexOf("/") + 1),
        input.version !== undefined,
      ),
    });
  }
  const total = read.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (total > (input.limit ?? ARTIFACT_ZIP_LIMIT_BYTES))
    throw new AppError("INVALID_INPUT", { errorId: "artifact-zip-too-large" });
  const decision = await sources.zipLimit.admit(input.userId);
  if (!decision.allowed)
    return artifactRateLimitedResponse({ retryAfterSeconds: decision.retryAfterSeconds });
  const stored = await sources.blobs.inspectMany(
    input.workspaceId,
    read.files.map((file) => file.sha256),
  );
  if (read.files.some((file) => !stored.has(file.sha256))) throw new AppError("NOT_FOUND");
  const title = read.artifact.title || read.artifact.name;
  return new Response(zipStream(sources.blobs, input.workspaceId, read.files), {
    headers: artifactFileHeaders("application/zip", `${title}.zip`),
  });
}

function zipStream(
  blobs: Sources["blobs"],
  workspaceId: string,
  files: readonly { path: string; sha256: string }[],
): ReadableStream<Uint8Array> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const zip = new Zip((error, chunk, final) => {
    if (error) controller.error(error);
    else {
      controller.enqueue(chunk);
      if (final) controller.close();
    }
  });
  let next = 0;
  return new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
    async pull() {
      try {
        const file = files[next++];
        if (!file) return zip.end();
        const bytes = await blobs.read(workspaceId, file.sha256);
        if (!bytes) throw new AppError("NOT_FOUND");
        const entry = new ZipPassThrough(file.path);
        zip.add(entry);
        entry.push(bytes, true);
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

const PREVIEW_TEXT_LIMIT_BYTES = 1024 * 1024;

export async function artifactFilePreview(
  sources: Omit<Sources, "zipLimit">,
  input: Omit<Request, "limit"> & { path: string },
) {
  const read = await sources.reads.read({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    reader: { userId: input.userId },
    version: input.version,
  });
  const file = read.files.find((entry) => entry.path === input.path);
  if (!file) throw new AppError("NOT_FOUND");
  const shown = { path: file.path, sizeBytes: file.sizeBytes };
  const asText =
    file.kind === "text" &&
    artifactKindOfPath(file.path) !== "image" &&
    file.sizeBytes <= PREVIEW_TEXT_LIMIT_BYTES;
  if (!asText) return { ...shown, text: null };
  const bytes = await sources.blobs.read(input.workspaceId, file.sha256);
  if (!bytes) throw new AppError("NOT_FOUND");
  return { ...shown, text: new TextDecoder().decode(bytes) };
}
