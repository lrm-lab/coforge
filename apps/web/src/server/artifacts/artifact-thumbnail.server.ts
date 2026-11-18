import { AppError } from "#src/lib/app-error";
import type { StoredArtifactBlobs } from "./artifact-blobs.server";
import { artifactFileHeaders } from "./artifact-download.server";
import type { ArtifactReads } from "./artifact-reads.server";

const THUMBNAIL_EDGE_PX = 640;
const THUMBNAIL_MAX_PIXELS = 25_000_000;
const THUMBNAIL_DECODES_AT_ONCE = 2;

type Sources = {
  reads: Pick<ArtifactReads, "file">;
  blobs: Pick<StoredArtifactBlobs, "read">;
};

export async function artifactThumbnail(
  sources: Sources,
  input: { workspaceId: string; artifactId: string; userId: string; version: number; path: string },
): Promise<Response> {
  const file = await sources.reads.file({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    reader: { userId: input.userId },
    version: input.version,
    path: input.path,
  });
  if (!file) throw new AppError("NOT_FOUND");
  const { workspaceId } = input;
  const { sha256 } = file;
  const shrunk = await decodeSlot(async () => {
    const bytes = await sources.blobs.read(workspaceId, sha256);
    return (
      bytes &&
      new Bun.Image(bytes, { maxPixels: THUMBNAIL_MAX_PIXELS })
        .resize(THUMBNAIL_EDGE_PX, THUMBNAIL_EDGE_PX, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .bytes()
    );
  }).catch(() => null);
  if (!shrunk) throw new AppError("NOT_FOUND");
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  return new Response(shrunk.slice().buffer as ArrayBuffer, {
    headers: artifactFileHeaders("image/webp", `${name}.webp`, true),
  });
}

let decoding = 0;
const waiting: (() => void)[] = [];

async function decodeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (decoding < THUMBNAIL_DECODES_AT_ONCE) decoding += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else decoding -= 1;
  }
}
