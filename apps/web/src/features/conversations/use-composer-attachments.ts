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

export function useComposerAttachments(uploadTo: () => Promise<string>) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const inFlight = useRef(new Map<string, AbortController>());
  const removed = useRef(new Set<string>());
  const uploading = attachments.some(stillUploading);
  const attached = attachments.filter((item) => !cannotAttach(item.failure)).length;
  const room = Math.max(0, MAX_ATTACHMENTS - attached);
  const anyFailed = attachments.some((item) => item.failure) || attached > MAX_ATTACHMENTS;

  async function uploadOne(pending: PendingAttachment) {
    setAttachments((current) =>
      current.map((item) =>
        item.localId === pending.localId ? { ...item, failure: undefined, progress: 0 } : item,
      ),
    );
    const controller = new AbortController();
    inFlight.current.set(pending.localId, controller);
    try {
      const id = await uploadAttachment(
        await uploadTo(),
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
      if (controller.signal.aborted) return;
      const failure = error instanceof UploadRefused ? error.failure : "failed";
      setAttachments((current) =>
        current.map((item) => (item.localId === pending.localId ? { ...item, failure } : item)),
      );
    } finally {
      inFlight.current.delete(pending.localId);
    }
  }

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
