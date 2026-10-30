import { ATTACHMENT_MAX_BYTES } from "@lrm/coforge-sdk/internal";

/** At most 10 attachments per send, mirroring the server-side `attachmentIds` bound
 * (`conversation.schemas.ts`'s `attachmentIdsSchema`, the Agent API's `AgentMessagesSendRequest`). */
export const MAX_ATTACHMENTS = 10;

/**
 * Why a file did not upload, which the tile says instead of a bare "Upload failed" (task #291).
 * Found when the file is picked, as Raft's composer does, so it is never sent: `empty` (the server
 * refuses a 0-byte file too), `too_large` past `ATTACHMENT_MAX_BYTES` (also a 413 from the server
 * or a proxy in front of it), `too_many` past `MAX_ATTACHMENTS`. Found on the way: `signed_out`
 * (401: the session ended), `forbidden` (403: no longer a member here), `offline` (the request
 * never reached the server), else `failed`.
 */
export type UploadFailure =
  | "empty"
  | "too_large"
  | "too_many"
  | "signed_out"
  | "forbidden"
  | "offline"
  | "failed";

/** A failure a retry may get past; the others need something else first. */
export const retryableUploadFailure = (failure: UploadFailure) =>
  failure === "offline" || failure === "failed";

/** A failure found when the file was picked: the file was never sent, and is not attached. */
export const notAttachedFailure = (failure: UploadFailure | undefined) =>
  failure === "empty" || failure === "too_large" || failure === "too_many";

/**
 * What each picked file becomes, in order, given `room` attachments still free: an empty file and
 * one past the size limit are refused for that, whatever the room; of the rest, those past the
 * room are `too_many`. Raft's composer sorts a pick the same way. `undefined` uploads.
 */
export function pickedFileFailures(
  files: readonly Pick<File, "size">[],
  room: number,
): (UploadFailure | undefined)[] {
  let left = Math.max(0, room);
  return files.map((file) => {
    if (file.size === 0) return "empty";
    if (file.size > ATTACHMENT_MAX_BYTES) return "too_large";
    if (left === 0) return "too_many";
    left -= 1;
    return undefined;
  });
}

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
