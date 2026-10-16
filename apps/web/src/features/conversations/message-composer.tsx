import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useHydrated } from "@tanstack/react-router";

import { useAppToast } from "#src/components/ui/toast";
import { FileIcon as FileTypeIcon } from "@untitledui/file-icons";
import { AlertCircle, Download01, Plus, Send01, Trash01, XClose } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";

import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Button } from "#src/components/base/buttons/button";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  ProgressBar,
  ProgressBarBase,
} from "#src/components/base/progress-indicators/progress-indicators";
import { Dialog, DialogTrigger } from "#src/components/application/modals/modal";
import {
  dragCarriesFiles,
  filesFromDrop,
  filesFromPaste,
  localId,
  shouldSendAsTaskOnEnter,
  shouldSendOnEnter,
} from "./composer-behavior";
import { ensureInlineImage, imageFileFromUrl, imageUrlsFromPaste } from "./paste-image";
import { draftWithUnsentMessage, type OutgoingMessage, type SendOptions } from "./composer-outbox";
import { useComposerRequests, useMessageOutbox } from "./use-message-outbox";
import {
  clearComposerDraft,
  composerDraftKey,
  readComposerDraft,
  readComposerDraftPins,
  writeComposerDraft,
  writeComposerDraftPins,
} from "./composer-draft";
import type { Mentionable } from "./mention-text";
import {
  addMentionPin,
  mentionPinFor,
  mentionsByLabel,
  NO_PINS,
  pinsInText,
  unpinnedLabelMentions,
} from "./mention-pins";
import type { ChannelSuggestion } from "./reference-completion";
import { useReferenceCompletion } from "./use-reference-completion";
import { ReferenceSuggestionList } from "./reference-suggestions";
import { PendingMentionStrip, type PendingMention } from "./pending-mention-strip";
import { UnpinnedMentionHint } from "./unpinned-mention-hint";
import { fileIconType } from "./message-row";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

export type SentMessage = {
  id: string;
  sequence: number;
  body: string;
  createdAt: Date | string;
  attachmentFileName?: string;
  /** The `@handle`s this send left as text because they name nobody the sender can see. */
  unresolvedMentionHandles?: readonly string[];
  /** Mentions of people outside the channel this send did not notify, for the sender to act on. */
  pendingMentionActions?: readonly PendingMention[];
};

/** No name kept as text: one set every reset returns, so a state already holding it does not change. */
const NO_NAMES: ReadonlySet<string> = new Set();

/** At most 10 attachments per send, mirroring the server-side `attachmentIds` bound
 * (`conversation.schemas.ts`'s `attachmentIdsSchema`, the Agent API's `AgentMessagesSendRequest`). */
const MAX_ATTACHMENTS = 10;

export type PendingAttachment = {
  /** Stable key across renders and across the file's own upload lifecycle; independent of
   * `file` identity so two same-named files can coexist. */
  localId: string;
  file: File;
  /** Set once the server has accepted the upload. */
  id?: string;
  /** 0 to 100 while uploading. */
  progress: number;
  failed: boolean;
};

/** Upload a composer attachment, reporting progress, and resolve with its id. */
function uploadAttachment(
  conversationId: string,
  file: File,
  onProgress: (percent: number) => void,
) {
  return new Promise<string>((resolve, reject) => {
    const form = new FormData();
    form.set("conversationId", conversationId);
    form.set("file", file);
    const request = new XMLHttpRequest();
    request.open("POST", "/api/attachments");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve((JSON.parse(request.responseText) as { id: string }).id);
        } catch (cause) {
          reject(cause);
        }
      } else reject(new Error(request.responseText || `upload failed (${request.status})`));
    };
    request.onerror = () => reject(new Error("upload failed"));
    request.send(form);
  });
}

/**
 * One chosen file in the tray under the text, as Slack shows them: an image
 * is a 4rem thumbnail, any other file a card with its type icon, name and size, so a chosen
 * file is visible at a glance. While it uploads it is dimmed with a progress bar along its
 * foot; a failed upload rings it red. Clicking the tile opens the preview with the file's details, download, remove, and retry for a failed upload.
 */
function AttachmentTile({
  attachment,
  uploading,
  onRemove,
  onRetry,
}: {
  attachment: PendingAttachment;
  uploading: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { file } = attachment;
  const isImage = file.type.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const iconType = fileIconType(file.name, file.type);
  const extension = file.name.split(".").pop()?.toUpperCase();
  const kind = extension && extension !== file.name.toUpperCase() ? extension : file.type;
  const icon = (size: string) => (
    <>
      <FileTypeIcon className={`${size} dark:hidden`} type={iconType} theme="light" />
      <FileTypeIcon className={`${size} not-dark:hidden`} type={iconType} theme="dark" />
    </>
  );
  const status = attachment.failed
    ? m.conversation_attachment_failed()
    : uploading
      ? m.conversation_attachment_uploading({ progress: attachment.progress })
      : `${kind} · ${getReadableFileSize(file.size)}`;
  return (
    <li className="relative">
      <DialogTrigger>
        <Button
          color="tertiary"
          size="sm"
          noTextPadding
          aria-label={`${file.name} · ${status}`}
          className={cx(
            "overflow-hidden rounded-lg border border-primary bg-primary p-0 shadow-xs hover:bg-primary_hover",
            isImage ? "size-16" : "h-16 w-[13rem] justify-start px-3",
            attachment.failed && "border-error",
          )}
        >
          {isImage ? (
            previewUrl ? (
              <img
                src={previewUrl}
                alt=""
                className={cx("size-full object-cover", uploading && "opacity-60")}
              />
            ) : (
              <span className="flex size-full items-center justify-center bg-secondary">
                {icon("size-8")}
              </span>
            )
          ) : (
            <span className="flex min-w-0 items-center gap-2.5 text-left">
              <span className="flex size-9 shrink-0 items-center justify-center">
                {icon("size-9")}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-secondary">{file.name}</span>
                <span
                  className={cx(
                    "truncate text-xs",
                    attachment.failed ? "text-error-primary" : "text-tertiary",
                  )}
                >
                  {status}
                </span>
              </span>
            </span>
          )}
        </Button>
        <AriaPopover
          placement="top start"
          offset={8}
          className="w-[min(24rem,calc(100vw-2rem))] rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none"
        >
          <Dialog className="flex flex-col outline-none">
            {({ close }) => (
              <>
                {isImage && previewUrl && (
                  <div className="flex justify-center rounded-t-xl bg-secondary p-3">
                    <img
                      src={previewUrl}
                      alt=""
                      className="max-h-56 max-w-full rounded-md object-contain"
                    />
                  </div>
                )}
                <div className="flex items-center gap-3 p-3">
                  {!isImage && (
                    <span className="flex size-10 shrink-0 items-center justify-center">
                      {icon("size-10")}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-primary">{file.name}</p>
                    <p className="truncate text-sm text-tertiary">
                      {uploading
                        ? `${attachment.progress}% · ${getReadableFileSize(file.size)}`
                        : `${kind} · ${getReadableFileSize(file.size)}`}
                    </p>
                    {uploading && <ProgressBar value={attachment.progress} className="mt-1.5" />}
                    {attachment.failed && (
                      <Button color="link-color" size="sm" onPress={onRetry} className="mt-1">
                        {m.controls_retry()}
                      </Button>
                    )}
                  </div>
                  <ButtonUtility
                    icon={Download01}
                    size="sm"
                    color="tertiary"
                    tooltip={m.conversation_attachment_download()}
                    href={previewUrl}
                    download={file.name}
                  />
                  <ButtonUtility
                    icon={Trash01}
                    size="sm"
                    color="tertiary"
                    tooltip={m.conversation_attachment_remove()}
                    onClick={() => {
                      close();
                      onRemove();
                    }}
                  />
                </div>
              </>
            )}
          </Dialog>
        </AriaPopover>
      </DialogTrigger>
      {uploading && (
        <ProgressBarBase
          value={attachment.progress}
          className="pointer-events-none absolute inset-x-2 bottom-1.5 h-1 w-auto"
        />
      )}
      {attachment.failed && isImage && (
        <AlertCircle
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary text-fg-error-primary"
        />
      )}
    </li>
  );
}

/**
 * The message form at the foot of a conversation or thread. Owns the draft, the pending
 * attachments (each uploaded sequentially as soon as it is chosen, so its progress is
 * visible), the "as task" toggle and the retry idempotency key, so typing never re-renders the
 * history above it.
 */
export function MessageComposer({
  conversationId,
  threadRootId,
  inThread,
  target,
  mentionables,
  mentionOutsiders,
  recentHandles,
  channels,
  quotedDraft,
  onSend,
  canSendAsTask,
  onSent,
}: {
  conversationId: string;
  /** The thread root this composer replies to; absent for the main pane. Together with
   * `conversationId` it scopes the device-local draft, so the main pane and each thread
   * keep their own unsent text. */
  threadRootId?: string;
  /** Thread composers cannot create Tasks. */
  inThread: boolean;
  /** Who the main pane's messages go to (`#channel`, `@name`), named in its placeholder. */
  target?: string;
  /** The conversation's @-completion candidates; absent or empty, `@` opens no popup. */
  mentionables?: readonly Mentionable[];
  /** The channel's people and public Agents outside it, offered after the members. */
  mentionOutsiders?: readonly Mentionable[];
  /** Handles that recently sent a message in this conversation, most-recent first (channels
   * only); ranks @-completion candidates ahead of alphabetical order. */
  recentHandles?: readonly string[];
  /** The Workspace's channels for #-completion; `conversationId` leads the list when it is one. */
  channels?: readonly ChannelSuggestion[];
  /** A finished quote from a message the reader highlighted (`message-row.tsx`'s reply-to-
   * selection), to be appended to the draft. The `id` is what makes a repeat insertion of the same
   * text land again, so it is the caller's monotone counter — never a content hash. */
  quotedDraft?: { id: number; text: string };
  onSend: (
    body: string,
    idempotencyKey: string,
    attachmentIds?: string[],
    options?: SendOptions,
  ) => Promise<SentMessage | void>;
  /** Whether a top-level send may go "As task" (thread composers never offer it). */
  canSendAsTask?: boolean;
  /** A message of the current user's was accepted by the server. */
  onSent?: (message: SentMessage) => void;
}) {
  const composerId = useId();
  const hydrated = useHydrated();
  const toast = useAppToast();
  // Device-local draft, scoped to this chat (and thread): typing here never touches another
  // conversation, and the text survives switching chats, reloads, and restarts on this device.
  const draftKey = composerDraftKey(conversationId, threadRootId);
  // A failed send keeps its idempotency key so a retry of the same text is idempotent.
  const retryRef = useRef<{ body: string; idempotencyKey: string; asTask: boolean } | undefined>(
    undefined,
  );
  const [body, setBody] = useState(() => readComposerDraft(draftKey));
  // Who each `@name` in the draft was picked to mean; sending turns those names into handles. Kept
  // with the draft and in step with its text: a name edited away takes its pin with it.
  const [pins, setPins] = useState(() => readComposerDraftPins(draftKey));
  // Names the sender chose to leave as text when asked who they meant.
  const [keptAsText, setKeptAsText] = useState(NO_NAMES);
  useEffect(() => {
    setBody(readComposerDraft(draftKey));
    setPins(readComposerDraftPins(draftKey));
    setKeptAsText(NO_NAMES);
    retryRef.current = undefined;
  }, [draftKey]);
  useEffect(() => {
    writeComposerDraft(draftKey, body);
    setPins((current) => pinsInText(body, current));
  }, [draftKey, body]);
  useEffect(() => {
    writeComposerDraftPins(draftKey, pins);
  }, [draftKey, pins]);
  // @-member and #-channel completion: query tracking, popup state, and keyboard interaction.
  const completion = useReferenceCompletion({
    mentionables,
    mentionOutsiders,
    recentHandles,
    channels,
    currentChannelId: conversationId,
    value: body,
    onChange: (next) => {
      setBody(next);
      if (retryRef.current && next.trim() !== retryRef.current.body) retryRef.current = undefined;
    },
    onPickMention: pinMention,
  });
  // A name typed by hand that matches a member, never picked: sending it notifies no one, so the
  // composer offers who was meant. Not while the `@` list is open, which is already asking.
  const namedCandidates = useMemo(
    () => mentionsByLabel([...(mentionables ?? []), ...(mentionOutsiders ?? [])]),
    [mentionables, mentionOutsiders],
  );
  const unpinned = useMemo(
    () =>
      completion.open
        ? undefined
        : unpinnedLabelMentions(body, pins, namedCandidates).find(
            (mention) => !keptAsText.has(mention.label),
          ),
    [completion.open, body, pins, namedCandidates, keptAsText],
  );
  // What this chat's newest accepted send did not reach: `@handle`s that name nobody, and mentions
  // of people outside the channel. Kept with the chat and the message's position: a reply that
  // lands after the reader moved to another chat, or after a newer send's reply, never replaces it.
  const [unresolved, setUnresolved] = useState<
    | {
        draftKey: string;
        sequence: number;
        handles: readonly string[];
        pendingMentions: readonly PendingMention[];
      }
    | undefined
  >(undefined);
  const current = unresolved?.draftKey === draftKey ? unresolved : undefined;
  const unresolvedHandles = current?.handles ?? [];
  const pendingMentions = current?.pendingMentions ?? [];
  const unresolvedNotice = unresolvedHandles.length
    ? m.conversation_unresolved_mentions({
        handles: new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(
          unresolvedHandles.map((handle) => `@${handle}`),
        ),
      })
    : "";
  // Submitting clears the composer at once and never disables it, so the next message can be
  // typed straight away; the outbox holds each submitted message until the server accepts it,
  // and the conversation shows it (greyed, then failed if need be) in the message list.
  const outbox = useMessageOutbox({
    draftKey,
    onSend,
    onSent: (message) => {
      onSent?.(message);
      setUnresolved((current) =>
        current?.draftKey === draftKey && current.sequence > message.sequence
          ? current
          : {
              draftKey,
              sequence: message.sequence,
              handles: message.unresolvedMentionHandles ?? [],
              pendingMentions: message.pendingMentionActions ?? [],
            },
      );
    },
  });
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [asTask, setAsTask] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The last quote this composer consumed. Held by id so a re-render (or an unrelated state
  // change) never re-inserts a quote the reader already has in the draft.
  const consumedQuoteIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!quotedDraft || quotedDraft.id === consumedQuoteIdRef.current) return;
    consumedQuoteIdRef.current = quotedDraft.id;
    // Appended, not replaced: a quote answers what the reader was already writing as often as it
    // starts a reply, and losing their draft to a highlight would be unforgivable.
    setBody((current) => {
      const kept = current.replace(/\s+$/u, "");
      return kept ? `${kept}\n\n${quotedDraft.text}\n\n` : `${quotedDraft.text}\n\n`;
    });
    retryRef.current = undefined;
    // The draft is React state, so the caret can only be placed once the textarea has re-rendered
    // with the quote in it.
    requestAnimationFrame(focusComposer);
  }, [quotedDraft]);
  // IME composition tracking for Enter-to-send: see composer-behavior.ts.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);
  // Counts nested dragenter/dragleave pairs across the form's descendants, so the drop
  // affordance does not flicker as the pointer crosses child element boundaries.
  const dragDepthRef = useRef(0);
  const [draggingFile, setDraggingFile] = useState(false);
  const uploading = attachments.some((item) => !item.id && !item.failed);
  const anyFailed = attachments.some((item) => item.failed);
  const composerDisabled = !hydrated;
  const dropDisabled = composerDisabled || uploading;

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

  function pinMention(mention: Mentionable) {
    setPins((current) => addMentionPin(current, mentionPinFor(mention)));
  }

  function returnFocusToComposer() {
    completion.textareaRef.current?.focus({ preventScroll: true });
  }

  function focusComposer() {
    const textarea = completion.textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  // Opening a conversation or thread puts the caret in its composer, as a chat app does, so the
  // first message needs no click. Only with a fine pointer: on touch it would pop the keyboard.
  // The textarea is disabled until hydration, and a disabled field cannot take focus.
  useEffect(() => {
    if (hydrated && window.matchMedia("(pointer: fine)").matches) focusComposer();
  }, [draftKey, hydrated]);

  /** Sends the draft; `forceAsTask` (the Cmd/Ctrl+Shift+Enter shortcut) sends it as a Task
   * whether or not "As task" is ticked, as Raft's composer does. */
  function submit(event?: FormEvent<HTMLFormElement>, forceAsTask = false) {
    event?.preventDefault();
    const text = body.trim() || attachments[0]?.file.name || "";
    if (!text || uploading || anyFailed || attachments.length > MAX_ATTACHMENTS) return;
    const sendAsTask = (asTask || forceAsTask) && !inThread && Boolean(canSendAsTask);
    const idempotencyKey =
      retryRef.current?.body === text && retryRef.current.asTask === sendAsTask
        ? retryRef.current.idempotencyKey
        : localId();
    // Only files that finished uploading and were not removed.
    const uploaded = attachments.filter((item) => item.id);
    const message: OutgoingMessage = {
      localId: localId(),
      draftKey,
      body: text,
      pins: pinsInText(text, pins),
      idempotencyKey,
      asTask: sendAsTask,
      attachments: uploaded.flatMap((item) =>
        item.id ? [{ id: item.id, fileName: item.file.name }] : [],
      ),
    };
    retryRef.current = undefined;
    setBody("");
    setPins(NO_PINS);
    setKeptAsText(NO_NAMES);
    clearComposerDraft(draftKey);
    completion.close();
    setAttachments([]);
    setAsTask(false);
    // A click on the send button moved focus there; typing continues in the composer.
    focusComposer();
    outbox.send(message, uploaded);
  }

  // "Edit" on an unsent message in the conversation puts it back here, ahead of anything typed
  // since; sending it again unchanged reuses its idempotency key. Retry and Delete just hand the focus
  // back, since the row button that held it is gone.
  useComposerRequests(draftKey, (request) => {
    if (request.kind === "focus") {
      focusComposer();
      return;
    }
    setBody((current) => draftWithUnsentMessage(current, request.body));
    setPins((current) => request.pins.reduce(addMentionPin, current));
    setAttachments((current) => [...request.chips, ...current]);
    if (request.asTask) setAsTask(true);
    retryRef.current = {
      body: request.body,
      idempotencyKey: request.idempotencyKey,
      asTask: request.asTask,
    };
    requestAnimationFrame(focusComposer);
  });

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The open completion owns navigation and confirmation keys; Enter must not send while a
    // candidate is being picked. During IME composition the keys belong to the IME.
    if (completion.handleKeyDown(event, isComposingRef.current)) return;
    const composition = { lastCompositionEndAt: lastCompositionEndAtRef.current, now: Date.now() };
    const key = {
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing || isComposingRef.current,
      keyCode: event.keyCode,
    };
    if (taskMode && shouldSendAsTaskOnEnter(key, composition)) {
      event.preventDefault();
      submit(undefined, true);
      return;
    }
    if (shouldSendOnEnter(key, composition)) {
      event.preventDefault();
      submit();
    }
  }

  function compositionStart(_event: CompositionEvent<HTMLTextAreaElement>) {
    isComposingRef.current = true;
  }

  function compositionEnd(_event: CompositionEvent<HTMLTextAreaElement>) {
    isComposingRef.current = false;
    lastCompositionEndAtRef.current = Date.now();
  }

  /** Paste images through the same upload path as the paperclip button. Covers three clipboard
   * shapes: real file bytes (Finder copies, screenshot tools), image URLs without bytes (copied
   * from a web page — fetched to a blob here), and non-inline rasters (e.g. TIFF — re-encoded to
   * PNG). A paste with nothing image-like now says so instead of staying silent, which used to
   * read as a broken send button. Plain-text pastes are still left to the browser. */
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboard = event.clipboardData;
    const files = filesFromPaste(clipboard);
    const urls = files.length > 0 ? [] : imageUrlsFromPaste(clipboard);
    if (files.length === 0 && urls.length === 0) return;
    event.preventDefault();
    const inlineReady = await Promise.all(files.map((file) => ensureInlineImage(file)));
    const fetched: File[] = [];
    for (const url of urls) {
      if (fetched.length + inlineReady.length + attachments.length >= MAX_ATTACHMENTS) break;
      const file = await imageFileFromUrl(url);
      if (file) fetched.push(await ensureInlineImage(file));
    }
    const ready = [...inlineReady, ...fetched];
    if (ready.length === 0) {
      toast.error(m.conversation_paste_no_image());
      return;
    }
    void addFiles(ready);
  }

  /**
   * Drag a file over the composer to upload it through the same path as paste and the
   * paperclip button. Only a native file drag (`dragCarriesFiles`) is intercepted; a text or
   * URL drag is left untouched so the browser's own drop-to-insert behaviour still reaches the
   * textarea. Always calling `preventDefault` for a file drag (even while disabled) also keeps
   * the browser from navigating away to open the dropped file.
   */
  function dragEnter(event: DragEvent<HTMLFormElement>) {
    if (!dragCarriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    if (dropDisabled) return;
    dragDepthRef.current += 1;
    setDraggingFile(true);
  }

  function dragOver(event: DragEvent<HTMLFormElement>) {
    if (!dragCarriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dropDisabled ? "none" : "copy";
  }

  function dragLeave(event: DragEvent<HTMLFormElement>) {
    if (!dragCarriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingFile(false);
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    if (!dragCarriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFile(false);
    if (dropDisabled) return;
    const files = filesFromDrop(event.dataTransfer);
    if (files.length > 0) void addFiles(files);
  }

  const taskMode = !inThread && Boolean(canSendAsTask);
  return (
    <form
      onSubmit={submit}
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
      className={cx(
        "relative mx-4 mt-2 mb-3 flex shrink-0 flex-col gap-1 rounded-xl border border-primary bg-primary p-2 transition-shadow focus-within:border-fg-quaternary focus-within:shadow-xs md:mx-6",
        draggingFile && "ring-2 ring-brand",
      )}
    >
      {draggingFile && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-brand-secondary text-sm font-medium text-brand-primary">
          {m.conversation_drop_to_upload()}
        </div>
      )}
      {pendingMentions.length > 0 && (
        <PendingMentionStrip
          key={current?.sequence}
          mentions={pendingMentions}
          onSettle={(resolutionIds, outcome) =>
            setUnresolved(
              (report) =>
                report && {
                  ...report,
                  pendingMentions: report.pendingMentions.map((mention) =>
                    resolutionIds.includes(mention.resolutionId)
                      ? { ...mention, outcome }
                      : mention,
                  ),
                },
            )
          }
          onRemove={(resolutionId) =>
            setUnresolved(
              (report) =>
                report && {
                  ...report,
                  pendingMentions: report.pendingMentions.filter(
                    (mention) => mention.resolutionId !== resolutionId,
                  ),
                },
            )
          }
        />
      )}
      {/* Always mounted, so a screen reader announces the notice when its text arrives. */}
      <p role="status" className="sr-only">
        {unresolvedNotice}
      </p>
      {unresolvedNotice && (
        <div className="flex items-start gap-2 px-2 text-sm text-tertiary">
          <AlertCircle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-fg-warning-primary"
          />
          <p aria-hidden="true" className="min-w-0 flex-1">
            {unresolvedNotice}
          </p>
          <ButtonUtility
            icon={XClose}
            size="xs"
            color="tertiary"
            tooltip={m.conversation_unresolved_mentions_dismiss()}
            onClick={() => setUnresolved((report) => report && { ...report, handles: [] })}
          />
        </div>
      )}
      {unpinned && (
        <UnpinnedMentionHint
          label={unpinned.label}
          candidates={unpinned.candidates}
          onPick={(mention) => {
            pinMention(mention);
            returnFocusToComposer();
          }}
          onDismiss={() => {
            setKeptAsText((current) => new Set(current).add(unpinned.label));
            returnFocusToComposer();
          }}
        />
      )}
      <label htmlFor={composerId} className="sr-only">
        {m.conversation_message_label()}
      </label>
      <textarea
        id={composerId}
        ref={completion.textareaRef}
        rows={1}
        value={body}
        disabled={composerDisabled}
        onChange={(event) => {
          setBody(event.target.value);
          completion.track(event.target.value, event.target.selectionStart);
          if (retryRef.current && event.target.value.trim() !== retryRef.current.body)
            retryRef.current = undefined;
        }}
        onSelect={(event) =>
          completion.track(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onBlur={completion.close}
        onKeyDown={keyDown}
        onCompositionStart={compositionStart}
        onCompositionEnd={compositionEnd}
        onPaste={paste}
        aria-expanded={completion.open || undefined}
        aria-controls={completion.open ? completion.listboxId : undefined}
        aria-activedescendant={
          completion.open ? completion.optionId(completion.activeIndex) : undefined
        }
        placeholder={
          inThread
            ? m.conversation_thread_message_placeholder()
            : target
              ? m.conversation_message_placeholder_to({ target })
              : m.conversation_message_placeholder()
        }
        className="max-h-40 min-h-8 w-full resize-none bg-transparent px-3 py-1 text-md outline-none [field-sizing:content] placeholder:text-placeholder disabled:opacity-50"
      />
      {completion.open && completion.trigger && (
        <ReferenceSuggestionList
          id={completion.listboxId}
          trigger={completion.trigger}
          items={completion.items}
          activeIndex={completion.activeIndex}
          optionId={completion.optionId}
          onChoose={completion.choose}
          onHighlight={completion.setActiveIndex}
        />
      )}
      {attachments.length > 0 && (
        <ul
          aria-label={m.conversation_attachment_tray()}
          className="flex flex-wrap gap-2 px-3 pt-1 pb-1"
        >
          {attachments.map((item) => (
            <AttachmentTile
              key={item.localId}
              attachment={item}
              uploading={!item.id && !item.failed}
              onRemove={() =>
                setAttachments((current) =>
                  current.filter((other) => other.localId !== item.localId),
                )
              }
              onRetry={() => void uploadOne(item)}
            />
          ))}
        </ul>
      )}
      {attachments.length > MAX_ATTACHMENTS && (
        <p className="px-2 text-sm text-error-primary">
          {m.conversation_attachment_limit({ max: MAX_ATTACHMENTS })}
        </p>
      )}
      <div className="flex items-center gap-2 px-1 pb-0.5">
        <Button
          color="tertiary"
          size="xs"
          iconLeading={Plus}
          aria-label={m.conversation_attachment_label()}
          isDisabled={composerDisabled}
          onPress={() => fileInputRef.current?.click()}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={composerDisabled}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) void addFiles(files);
          }}
          className="sr-only"
        />
        {/* "As task" sits directly left of Send (the boss's ruling, #137), as a labelled checkbox
            that is always shown, as Raft's composer has it: the label says what it does, and one
            control holds both states. No hairline between the checkbox and Send (task #265). */}
        <div className="ml-auto flex items-center gap-3">
          {taskMode && (
            // A toggle with the shortcut in its tooltip, as Raft's "As Task" is: the official
            // Tooltip needs a pressable trigger, which a Checkbox's label is not.
            <Tooltip title={m.tasks_send_as_task_shortcut()}>
              <TooltipTrigger
                aria-pressed={asTask}
                isDisabled={composerDisabled}
                onPress={() => setAsTask((current) => !current)}
                className="flex items-center gap-2 text-sm font-medium text-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckboxBase size="sm" isSelected={asTask} isDisabled={composerDisabled} />
                {m.tasks_as_task()}
              </TooltipTrigger>
            </Tooltip>
          )}
          <Button
            type="submit"
            color="primary"
            size="xs"
            iconLeading={Send01}
            aria-label={m.conversation_send()}
            className="*:data-icon:text-white hover:*:data-icon:text-white"
            isDisabled={
              composerDisabled ||
              uploading ||
              anyFailed ||
              attachments.length > MAX_ATTACHMENTS ||
              (!body.trim() && attachments.length === 0)
            }
          />
        </div>
      </div>
    </form>
  );
}
