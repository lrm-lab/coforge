import { useEffect, useRef, useState } from "react";
import { isLongMessage, longMessageAsFile } from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import { composerUploadsSettled } from "./composer-send-gate";

export function useLongMessage({
  draftKey,
  body,
  setBody,
  addFiles,
  uploading,
  anyFailed,
  submit,
}: {
  draftKey: string;
  body: string;
  setBody: (body: string) => void;
  addFiles: (files: File[]) => Promise<void>;
  uploading: boolean;
  anyFailed: boolean;
  submit: (options?: { fromQueuedUpload?: boolean }) => void;
}) {
  const [waitingDraftKey, setWaitingDraftKey] = useState<string | null>(null);
  const previews = useRef(new WeakMap<File, string>());
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    const settled = composerUploadsSettled({
      waitingDraftKey,
      draftKey,
      uploading,
      anyFailed,
    });
    if (settled === "idle" || settled === "waiting") return;
    setWaitingDraftKey(null);
    if (settled === "send") submitRef.current({ fromQueuedUpload: true });
  }, [waitingDraftKey, draftKey, uploading, anyFailed]);

  function asFile(text: string) {
    const long = longMessageAsFile(text, {
      note: m.conversation_long_message_note(),
      now: new Date(),
    });
    const file = new File([long.content], long.fileName, { type: "text/markdown" });
    previews.current.set(file, long.preview);
    return { file, preview: long.preview };
  }

  function pasted(text: string) {
    void addFiles([asFile(text).file]);
  }

  function divert() {
    if (!isLongMessage(body)) return false;
    const { file, preview } = asFile(body);
    setBody(preview);
    void addFiles([file]);
    setWaitingDraftKey(draftKey);
    return true;
  }

  function sendAfterUploads() {
    setWaitingDraftKey(draftKey);
  }

  function cancelWaitingSend() {
    setWaitingDraftKey(null);
  }

  function emptyBody(files: readonly { file?: File }[]) {
    return files
      .map((item) => (item.file ? previews.current.get(item.file) : undefined))
      .find(Boolean);
  }

  return {
    divert,
    sendAfterUploads,
    cancelWaitingSend,
    waitingToSend: waitingDraftKey === draftKey,
    pasted,
    emptyBody,
  };
}
