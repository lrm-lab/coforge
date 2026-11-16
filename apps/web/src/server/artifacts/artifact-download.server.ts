import { Zip, ZipPassThrough } from "fflate";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import { ARTIFACT_ZIP_LIMIT_BYTES } from "#src/features/artifacts/artifact-zip-limit";
import { AppError } from "#src/lib/app-error";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import { artifactContentType } from "./artifact-content-types.server";
import type { ArtifactReads } from "./artifact-reads.server";

type Sources = {
  reads: Pick<ArtifactReads, "read">;
  blobs: Pick<StoredArtifactBlobs, "read" | "inspectMany">;
  zipLimit?: AppRateLimit;
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

const headers = (type: string, name: string) => ({
  "Content-Type": type,
  "Content-Disposition": attachment(name),
  "Cache-Control": "private, no-store",
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
      headers: headers(
        artifactContentType(file.path, file.kind),
        file.path.slice(file.path.lastIndexOf("/") + 1),
      ),
    });
  }
  const total = read.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (total > (input.limit ?? ARTIFACT_ZIP_LIMIT_BYTES))
    throw new AppError("INVALID_INPUT", { errorId: "artifact-zip-too-large" });
  const decision = await sources.zipLimit?.admit(input.userId);
  if (decision && !decision.allowed)
    return Response.json(
      {
        code: "RATE_LIMITED",
        retryable: true,
        details: { retryAfterSeconds: decision.retryAfterSeconds },
      },
      {
        status: 429,
        headers: { "Retry-After": String(decision.retryAfterSeconds), "Cache-Control": "no-store" },
      },
    );
  const stored = await sources.blobs.inspectMany(
    input.workspaceId,
    read.files.map((file) => file.sha256),
  );
  if (read.files.some((file) => !stored.has(file.sha256))) throw new AppError("NOT_FOUND");
  const title = read.artifact.title || read.artifact.name;
  return new Response(zipStream(sources.blobs, input.workspaceId, read.files), {
    headers: headers("application/zip", `${title}.zip`),
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
const PREVIEW_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;

export async function artifactFilePreview(
  sources: Sources,
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
  const contentType = artifactContentType(file.path, file.kind);
  const shown = { path: file.path, sizeBytes: file.sizeBytes, contentType };
  const image = artifactKindOfPath(file.path) === "image";
  const asImage = image && file.sizeBytes <= PREVIEW_IMAGE_LIMIT_BYTES;
  const asText = !image && file.kind === "text" && file.sizeBytes <= PREVIEW_TEXT_LIMIT_BYTES;
  if (!asText && !asImage) return { ...shown, text: null, dataUrl: null };
  const bytes = await sources.blobs.read(input.workspaceId, file.sha256);
  if (!bytes) throw new AppError("NOT_FOUND");
  if (asText) return { ...shown, text: new TextDecoder().decode(bytes), dataUrl: null };
  return {
    ...shown,
    text: null,
    dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
  };
}
