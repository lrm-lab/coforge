import { ATTACHMENT_MAX_BYTES } from "@lrm/coforge-sdk/internal";

/**
 * Why a file did not upload, which the tile says instead of a bare "Upload failed" (task #291):
 * `too_large` past `ATTACHMENT_MAX_BYTES` (found when the file is picked, or refused by the server
 * or a proxy in front of it with a 413), `signed_out` (401: the session ended), `forbidden` (403:
 * no longer a member here), `offline` (the request never reached the server), else `failed`.
 */
export type UploadFailure = "too_large" | "signed_out" | "forbidden" | "offline" | "failed";

/** A failure a retry may get past; the others need something else first. */
export const retryableUploadFailure = (failure: UploadFailure) =>
  failure === "offline" || failure === "failed";

/** A file the server would refuse for its size, refused before it is sent. */
export const oversizedUpload = (file: Pick<File, "size">): UploadFailure | undefined =>
  file.size > ATTACHMENT_MAX_BYTES ? "too_large" : undefined;

/** The failure a refused upload's answer names (`AttachmentUploadRefusal`, or its status). */
export function refusedUploadFailure(status: number): UploadFailure {
  if (status === 413) return "too_large";
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  return "failed";
}

/** An upload that did not land, and why. */
export class UploadRefused extends Error {
  constructor(readonly failure: UploadFailure) {
    super(`upload refused: ${failure}`);
  }
}

/** A chosen file still on its way: not accepted yet, and not refused. */
export const stillUploading = (item: { id?: string; failure?: UploadFailure }) =>
  !item.id && !item.failure;
