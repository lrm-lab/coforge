import { useState } from "react";

import { uploadAttachment, type PendingAttachment } from "./composer-attachments";
import {
  MAX_ATTACHMENTS,
  notAttachedFailure,
  pickedFileFailures,
  stillUploading,
  UploadRefused,
} from "./upload-failure";
import { localId } from "./composer-behavior";

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

  /** Adds one or more files and uploads those that can be attached, sequentially (one
   * `/api/attachments` request at a time, never in parallel). A file that cannot be attached (empty,
   * past the size limit, past `MAX_ATTACHMENTS`) still takes a tile that says why, as Raft's does,
   * and is never sent. */
  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    const attached = attachments.filter((item) => !notAttachedFailure(item.failure)).length;
    const failures = pickedFileFailures(files, MAX_ATTACHMENTS - attached);
    const pendingItems: PendingAttachment[] = files.map((file, index) => ({
      localId: localId(),
      file,
      progress: 0,
      failure: failures[index],
    }));
    setAttachments((current) => [...current, ...pendingItems]);
    for (const pending of pendingItems) {
      if (!pending.failure) await uploadOne(pending);
    }
  }

  return { attachments, setAttachments, uploading, anyFailed, uploadOne, addFiles };
}
