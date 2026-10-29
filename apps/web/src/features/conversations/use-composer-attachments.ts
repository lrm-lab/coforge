import { useState } from "react";

import { uploadAttachment, type PendingAttachment } from "./composer-attachments";
import { oversizedUpload, stillUploading, UploadRefused } from "./upload-failure";
import { localId } from "./composer-behavior";

/** At most 10 attachments per send, mirroring the server-side `attachmentIds` bound
 * (`conversation.schemas.ts`'s `attachmentIdsSchema`, the Agent API's `AgentMessagesSendRequest`). */
export const MAX_ATTACHMENTS = 10;

/**
 * The composer's attachments: the files chosen for the next send, each uploaded as soon as it is
 * added, one `/api/attachments` request at a time.
 */
export function useComposerAttachments(conversationId: string) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const uploading = attachments.some(stillUploading);
  const anyFailed = attachments.some((item) => item.failure);

  /** Uploads one already-added pending attachment, tracking it by `localId` regardless of
   * later reordering or removal of the others in `attachments`. */
  async function uploadOne(pending: PendingAttachment) {
    // A retry starts over: the tile shows it uploading, not the failure it is retrying.
    setAttachments((current) =>
      current.map((item) =>
        item.localId === pending.localId ? { ...item, failure: undefined, progress: 0 } : item,
      ),
    );
    try {
      const id = await uploadAttachment(conversationId, pending.file, (progress) =>
        setAttachments((current) =>
          current.map((item) => (item.localId === pending.localId ? { ...item, progress } : item)),
        ),
      );
      setAttachments((current) =>
        current.map((item) =>
          item.localId === pending.localId ? { ...item, id, progress: 100 } : item,
        ),
      );
    } catch (error) {
      const failure = error instanceof UploadRefused ? error.failure : "failed";
      setAttachments((current) =>
        current.map((item) => (item.localId === pending.localId ? { ...item, failure } : item)),
      );
    }
  }

  /** Adds and uploads one or more files, sequentially (one `/api/attachments` request at a
   * time, never in parallel), stopping at `MAX_ATTACHMENTS`. */
  async function addFiles(files: File[]) {
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const accepted = files.slice(0, room);
    if (accepted.length === 0) return;
    // A file past the limit says so on its tile at once and is never sent.
    const pendingItems: PendingAttachment[] = accepted.map((file) => ({
      localId: localId(),
      file,
      progress: 0,
      failure: oversizedUpload(file),
    }));
    setAttachments((current) => [...current, ...pendingItems]);
    for (const pending of pendingItems) {
      if (!pending.failure) await uploadOne(pending);
    }
  }

  return { attachments, setAttachments, uploading, anyFailed, uploadOne, addFiles };
}
