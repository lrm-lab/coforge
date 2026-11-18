import { useEffect, useRef, useState } from "react";
import { isLongMessage, longMessageAsFile } from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import { composerUploadsSettled } from "./composer-send-gate";

/**
 * Text longer than a message may be goes out as a Markdown file (task #138, shared rule in
 * `@lrm/coforge-sdk/internal/long-message.ts`), with no warning along the way (Frank). A paste that
 * long never enters the field: it lands in the tray as a `.md` at once, beside whatever else is
 * being written. A draft that grows past the limit by typing or by several pastes is turned at
 * Send: the full text goes to the tray the same way, its first lines (and the mentions past them)
 * stay as the message, and it sends on its own once the file has uploaded. Either way the file
 * goes through the tray like any other, with its progress, retry and ten-file limit; a failed
 * upload stops the send there, and Send is the person's again.
 */
export function useLongMessage({
  body,
  setBody,
  addFiles,
  uploading,
  anyFailed,
  submit,
}: {
  body: string;
  setBody: (body: string) => void;
  addFiles: (files: File[]) => Promise<void>;
  uploading: boolean;
  anyFailed: boolean;
  submit: () => void;
}) {
  const [sendWhenUploaded, setSendWhenUploaded] = useState(false);
  /** Each long text's message preview, by the file it became. */
  const previews = useRef(new WeakMap<File, string>());
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const settled = composerUploadsSettled({ waiting: sendWhenUploaded, uploading, anyFailed });
    if (settled === "idle" || settled === "waiting") return;
    setSendWhenUploaded(false);
    if (settled === "send") submitRef.current();
  }, [sendWhenUploaded, uploading, anyFailed]);

  /** The file a long text becomes; its preview is kept for a send with no words of its own. */
  function asFile(text: string) {
    const long = longMessageAsFile(text, {
      note: m.conversation_long_message_note(),
      now: new Date(),
    });
    const file = new File([long.content], long.fileName, { type: "text/markdown" });
    previews.current.set(file, long.preview);
    return { file, preview: long.preview };
  }

  /** A pasted long text, into the tray as its file. */
  function pasted(text: string) {
    void addFiles([asFile(text).file]);
  }

  /** At Send: turns a long draft into its file and preview, and reports whether it did. */
  function divert() {
    if (!isLongMessage(body)) return false;
    const { file, preview } = asFile(body);
    setBody(preview);
    void addFiles([file]);
    setSendWhenUploaded(true);
    return true;
  }

  function sendAfterUploads() {
    setSendWhenUploaded(true);
  }

  /** What a send with an empty field says: the preview of a long text it carries, if any. */
  function emptyBody(files: readonly { file: File }[]) {
    return files.map((item) => previews.current.get(item.file)).find(Boolean);
  }

  return { divert, sendAfterUploads, pasted, emptyBody };
}
