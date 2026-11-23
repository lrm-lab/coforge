import { useCallback, useSyncExternalStore } from "react";

import {
  draftAttachments,
  finishUpload,
  removeDraftAttachments,
  startUpload,
  subscribeDraftAttachments,
  updateDraftAttachments,
  wasRemoved,
} from "./composer-attachment-drafts";
import { uploadAttachment, type PendingAttachment } from "./composer-attachments";
import {
  cannotAttach,
  MAX_ATTACHMENTS,
  pickedFileFailures,
  stillUploading,
  UploadRefused,
} from "./upload-failure";
import { localId } from "./composer-behavior";

export function useComposerAttachments(draftKey: string, uploadTo: () => Promise<string>) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeDraftAttachments(draftKey, listener),
    [draftKey],
  );
  const attachments = useSyncExternalStore(
    subscribe,
    () => draftAttachments(draftKey),
    () => draftAttachments(draftKey),
  );
  const uploading = attachments.some(stillUploading);
  const attached = attachments.filter((item) => !cannotAttach(item.failure)).length;
  const room = Math.max(0, MAX_ATTACHMENTS - attached);
  const anyFailed = attachments.some((item) => item.failure) || attached > MAX_ATTACHMENTS;

  function setAttachments(
    update: (current: readonly PendingAttachment[]) => readonly PendingAttachment[],
  ) {
    updateDraftAttachments(draftKey, update);
  }

  function patch(key: string, localId: string, change: Partial<PendingAttachment>) {
    updateDraftAttachments(key, (current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
    );
  }

  async function uploadOne(pending: PendingAttachment) {
    if (!pending.file) return;
    const key = draftKey;
    patch(key, pending.localId, { failure: undefined, progress: 0 });
    const signal = startUpload(pending.localId);
    try {
      const id = await uploadAttachment(
        await uploadTo(),
        pending.file,
        (progress) => patch(key, pending.localId, { progress }),
        signal,
      );
      patch(key, pending.localId, { id, progress: 100 });
    } catch (error) {
      if (signal.aborted) return;
      const failure = error instanceof UploadRefused ? error.failure : "failed";
      patch(key, pending.localId, { failure });
    } finally {
      finishUpload(pending.localId);
    }
  }

  async function replace(targetLocalId: string, file: File) {
    const failures = pickedFileFailures([file], room + 1);
    const failure = failures[0];
    const replacement: PendingAttachment = {
      localId: targetLocalId,
      file,
      fileName: file.name,
      progress: 0,
      failure,
    };
    setAttachments((current) =>
      current.map((item) => (item.localId === targetLocalId ? replacement : item)),
    );
    if (!failure && !wasRemoved(targetLocalId)) await uploadOne(replacement);
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
      if (!pending.failure && !wasRemoved(pending.localId)) await uploadOne(pending);
    }
  }

  function remove(localIds: readonly string[]) {
    removeDraftAttachments(draftKey, localIds);
  }

  return {
    attachments,
    setAttachments,
    uploading,
    anyFailed,
    room,
    addFiles,
    tray: { attachments, retry: uploadOne, replace, remove },
  };
}
