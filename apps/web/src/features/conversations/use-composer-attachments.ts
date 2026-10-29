import { useState } from "react";

import { uploadAttachment, type PendingAttachment } from "./composer-attachments";
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
  const uploading = attachments.some((item) => !item.id && !item.failed);
  const anyFailed = attachments.some((item) => item.failed);

  /** Uploads one already-added pending attachment, tracking it by `localId` regardless of
   * later reordering or removal of the others in `attachments`. */
  async function uploadOne(pending: PendingAttachment) {
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
    } catch {
      setAttachments((current) =>
        current.map((item) =>
          item.localId === pending.localId ? { ...item, failed: true } : item,
        ),
      );
    }
  }

  /** Adds and uploads one or more files, sequentially (one `/api/attachments` request at a
   * time, never in parallel), stopping at `MAX_ATTACHMENTS`. */
  async function addFiles(files: File[]) {
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const accepted = files.slice(0, room);
    if (accepted.length === 0) return;
    const pendingItems: PendingAttachment[] = accepted.map((file) => ({
      localId: localId(),
      file,
      progress: 0,
      failed: false,
    }));
    setAttachments((current) => [...current, ...pendingItems]);
    for (const pending of pendingItems) {
      await uploadOne(pending);
    }
  }

  return { attachments, setAttachments, uploading, anyFailed, uploadOne, addFiles };
}
