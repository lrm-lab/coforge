import { useRef, useState } from "react";

import { uploadAttachment, type PendingAttachment } from "./composer-attachments";
import {
  cannotAttach,
  MAX_ATTACHMENTS,
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
  /** The uploads in flight, so removing a tile cancels its request, and the tiles removed, so one
   * still waiting its turn is never sent. */
  const inFlight = useRef(new Map<string, AbortController>());
  const removed = useRef(new Set<string>());
  const uploading = attachments.some(stillUploading);
  /** The places a file that can be attached takes; one that cannot takes none. */
  const attached = attachments.filter((item) => !cannotAttach(item.failure)).length;
  const room = Math.max(0, MAX_ATTACHMENTS - attached);
  // A send waits on every failure, as Raft's does ("Remove or retry failed attachments before
  // sending"), and on more than `MAX_ATTACHMENTS`, which an edit's chips can bring.
  const anyFailed = attachments.some((item) => item.failure) || attached > MAX_ATTACHMENTS;

  /** Uploads one already-added pending attachment, tracking it by `localId` regardless of
   * later reordering or removal of the others in `attachments`. */
  async function uploadOne(pending: PendingAttachment) {
    // A retry starts over: the tile shows it uploading, not the failure it is retrying.
    setAttachments((current) =>
      current.map((item) =>
        item.localId === pending.localId ? { ...item, failure: undefined, progress: 0 } : item,
      ),
    );
    const controller = new AbortController();
    inFlight.current.set(pending.localId, controller);
    try {
      const id = await uploadAttachment(
        conversationId,
        pending.file,
        (progress) =>
          setAttachments((current) =>
            current.map((item) =>
              item.localId === pending.localId ? { ...item, progress } : item,
            ),
          ),
        controller.signal,
      );
      setAttachments((current) =>
        current.map((item) =>
          item.localId === pending.localId ? { ...item, id, progress: 100 } : item,
        ),
      );
    } catch (error) {
      // A removed tile's upload was cancelled; there is nothing left to mark.
      if (controller.signal.aborted) return;
      const failure = error instanceof UploadRefused ? error.failure : "failed";
      setAttachments((current) =>
        current.map((item) => (item.localId === pending.localId ? { ...item, failure } : item)),
      );
    } finally {
      inFlight.current.delete(pending.localId);
    }
  }

  /** Adds one or more files and uploads those that can be attached, sequentially (one
   * `/api/attachments` request at a time, never in parallel). A file that cannot be attached (empty,
   * past the size limit, past `MAX_ATTACHMENTS`) still takes a tile that says why, as Raft's does,
   * and is never sent. */
  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    const failures = pickedFileFailures(files, room);
    const pendingItems: PendingAttachment[] = files.map((file, index) => ({
      localId: localId(),
      file,
      progress: 0,
      failure: failures[index],
    }));
    setAttachments((current) => [...current, ...pendingItems]);
    for (const pending of pendingItems) {
      if (!pending.failure && !removed.current.has(pending.localId)) await uploadOne(pending);
    }
  }

  /** Takes tiles out of the tray, cancelling any upload still on its way. */
  function remove(localIds: readonly string[]) {
    for (const id of localIds) {
      removed.current.add(id);
      inFlight.current.get(id)?.abort();
    }
    setAttachments((current) => current.filter((item) => !localIds.includes(item.localId)));
  }

  return {
    attachments,
    setAttachments,
    uploading,
    anyFailed,
    room,
    addFiles,
    tray: { attachments, retry: uploadOne, remove },
  };
}
