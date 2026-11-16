import { z } from "zod";
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES } from "@lrm/coforge-sdk/agent";

import { ARTIFACT_RATE_LIMITED_ERROR_ID } from "#src/features/artifacts/artifact-rate-limited";
import { isAppError } from "#src/lib/app-error";
import { isFile } from "#src/server/attachments/upload-file.server";
import { textResponse } from "#src/server/http/text-response.server";
import { artifactRateLimitedResponse } from "./artifact-rate-limited-response.server";

const FORM_OVERHEAD_BYTES = 64 * 1024;

const upload = z.object({ file: z.custom<File>(isFile) });

const tooLarge = () => textResponse("too large", { status: 413 });

export async function commentImageUploadResponse(
  request: Request,
  store: (bytes: Uint8Array<ArrayBuffer>) => Promise<{ sha256: string }>,
): Promise<Response> {
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared))
    return textResponse("content-length is required", { status: 411 });
  if (Number(declared) > ARTIFACT_COMMENT_IMAGE_MAX_BYTES + FORM_OVERHEAD_BYTES) return tooLarge();
  const form = await request.formData().catch(() => undefined);
  const file = form?.get("file");
  if (isFile(file) && file.size > ARTIFACT_COMMENT_IMAGE_MAX_BYTES) return tooLarge();
  const parsed = upload.safeParse({ file });
  if (!parsed.success) return textResponse("invalid", { status: 400 });
  try {
    const stored = await store(new Uint8Array(await parsed.data.file.arrayBuffer()));
    return Response.json({ sha256: stored.sha256 });
  } catch (error) {
    if (isAppError(error) && error.errorId === ARTIFACT_RATE_LIMITED_ERROR_ID)
      return artifactRateLimitedResponse({
        retryAfterSeconds: Number(error.details?.retryAfterSeconds ?? 60),
      });
    if (isAppError(error) && error.errorId === "artifact-storage-full")
      return textResponse("storage full", { status: 413 });
    if (isAppError(error) && error.errorId === "artifact-image-too-large") return tooLarge();
    if (isAppError(error) && error.code === "INVALID_INPUT")
      return textResponse("invalid", { status: 400 });
    throw error;
  }
}
