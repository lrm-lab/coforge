import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ArtifactDirectoryDraft,
  ArtifactDirectoryInvocation,
  ArtifactDirectoryTransport,
} from "#src/artifact-directory-args";
import { asJson, requireCall } from "#src/artifact-transfer";
import { invalidArg } from "#src/cli-error";

type ImageAnswer = { contentType: string; sizeBytes: number; data: string };

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function runDownloadImage(
  invocation: ArtifactDirectoryInvocation,
  draft: Extract<ArtifactDirectoryDraft, { operation: "image" }>,
  transport: ArtifactDirectoryTransport,
  cwd: string,
): Promise<unknown> {
  const answer = (await requireCall(
    transport.artifact,
    "request",
  )({
    operation: "image",
    artifact: draft.artifact,
    image: draft.image,
  })) as ImageAnswer;
  const output = resolve(
    cwd,
    draft.output ?? `${draft.image}.${EXTENSIONS[answer.contentType] ?? "bin"}`,
  );
  const existing = await lstat(output).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || existing.isDirectory()))
    throw invalidArg(`Cannot write ${output}: it is a symbolic link or a directory`);
  const bytes = Buffer.from(answer.data, "base64");
  await Bun.write(output, bytes);
  return asJson(
    invocation,
    { artifact: draft.artifact, image: draft.image, output, sizeBytes: bytes.byteLength },
    `Saved image ${draft.image} (${answer.contentType}), ${bytes.byteLength} bytes, to ${output}.`,
  );
}
