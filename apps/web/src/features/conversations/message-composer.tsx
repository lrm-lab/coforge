import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useHydrated } from "@tanstack/react-router";

import { useAppToast } from "#src/components/ui/toast";
import { AlertCircle, Plus, UploadCloud02, XClose } from "@untitledui/icons";
import { FileTrigger } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useResizeObserver } from "#src/hooks/use-resize-observer";
import {
  dragCarriesFiles,
  filesFromDrop,
  filesFromPaste,
  localId,
  shouldSendAsTaskOnEnter,
  composerPlaceholder,
  shouldSendOnEnter,
  forcesStackedLayout,
} from "./composer-behavior";
import { ComposerSendButton } from "./composer-send-button";
import { COMPOSER_FOCUS_CLASS, COMPOSER_FRAME_CLASS } from "./composer-frame";
import { AttachmentTile, uploadAttachment, type PendingAttachment } from "./composer-attachments";
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

/** What sets the width of a line of draft text: shared by the textarea and its hidden one-line
 * copy, which measures whether the draft fits the one-line text column. */
const DRAFT_LINE_CLASS = "px-3 text-md";

/**
 * The message form at the foot of a conversation or thread. Owns the draft, the pending
 * attachments (each uploaded sequentially as soon as it is chosen, so its progress is
 * visible), whether an edited-back Task goes out as one, and the retry idempotency key, so typing
 * never re-renders the history above it.
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
  // Set only by editing an unsent Task back into the composer: Send then sends it as a Task again.
  const [asTask, setAsTask] = useState(false);
  // The edited-back Task belongs to its draft; another conversation's Send is a plain send again.
  useEffect(() => setAsTask(false), [draftKey]);
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
  const taskMode = !inThread && Boolean(canSendAsTask);
  const sendDisabled =
    composerDisabled ||
    uploading ||
    anyFailed ||
    attachments.length > MAX_ATTACHMENTS ||
    (!body.trim() && attachments.length === 0);
  // Whether the draft would wrap in the one-line text column, read from a hidden copy of it that
  // always sits in that column (see `forcesStackedLayout`). Once a newline or an attachment
  // stacks the composer anyway, the copy stays empty rather than laying out the draft twice.
  const stacksAnyway = forcesStackedLayout(body, attachments.length);
  const placeholder = composerPlaceholder(inThread, target);
  // The placeholder must fit too, or the composer stays stacked and typing never moves the box.
  const lineMirrorText = stacksAnyway ? "" : `${body}\n${placeholder}`;
  const lineMirrorRef = useRef<HTMLSpanElement>(null);
  const [overflowsLine, setOverflowsLine] = useState(false);
  const measureLine = useCallback(() => {
    const mirror = lineMirrorRef.current;
    if (mirror) setOverflowsLine(mirror.scrollWidth > mirror.clientWidth);
  }, []);
  // Before paint, so a restored long draft never shows a frame on one line.
  useLayoutEffect(measureLine, [lineMirrorText, measureLine]);
  useResizeObserver({ ref: lineMirrorRef, onResize: measureLine });
  const stacked = stacksAnyway || overflowsLine;
  // Stacked, `+` and send sit on the bottom bar (row 3, under the attachments).
  const barRow = stacked ? "row-start-3" : "row-start-1";

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

  /** Sends the draft, as a Task when `wantTask` (the send menu, Cmd/Ctrl+Shift+Enter) or, by
   * default, when it is an unsent Task edited back. */
  function submit(wantTask = asTask) {
    if (sendDisabled) return;
    const text = body.trim() || attachments[0]?.file.name || "";
    const sendAsTask = taskMode && wantTask;
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
      submit(true);
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

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
      className={`${COMPOSER_FOCUS_CLASS} ${COMPOSER_FRAME_CLASS}`}
    >
      {draggingFile && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-secondary text-sm font-medium text-secondary">
          <UploadCloud02 aria-hidden="true" className="size-5 text-fg-quaternary" />
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
      {/* One grid for both shapes: on one line `+`, the text and send share a row; stacked, the
          text spans the top, the attachments sit under it, and `+` and send drop to a bar whose
          middle cell is the one-line text column (so neither may change width between shapes).
          Only classes change, so the textarea (focus, caret, IME state) is never remounted. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-x-1">
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
          placeholder={placeholder}
          // Fits what it shows, placeholder included (as Raft's); scrolls only past max height.
          className={cx(
            "row-start-1 max-h-40 min-h-8 w-full resize-none bg-transparent py-1 outline-none [field-sizing:content] placeholder:text-placeholder disabled:opacity-50",
            DRAFT_LINE_CLASS,
            stacked ? "col-span-full" : "col-start-2",
          )}
        />
        {/* The draft and placeholder, unwrapped, in the one-line column: wider means a wrap. */}
        <span
          ref={lineMirrorRef}
          aria-hidden="true"
          className={cx(
            "invisible col-start-2 h-0 min-w-0 overflow-hidden whitespace-pre",
            DRAFT_LINE_CLASS,
            barRow,
          )}
        >
          {lineMirrorText}
        </span>
        {attachments.length > 0 && (
          <div className="col-span-full row-start-2 flex flex-col gap-1">
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
            {attachments.length > MAX_ATTACHMENTS && (
              <p className="px-2 text-sm text-error-primary">
                {m.conversation_attachment_limit({ max: MAX_ATTACHMENTS })}
              </p>
            )}
          </div>
        )}
        <FileTrigger
          allowsMultiple
          onSelect={(list) => {
            const files = Array.from(list ?? []);
            if (files.length > 0) void addFiles(files);
          }}
        >
          <Button
            color="tertiary"
            size="xs"
            iconLeading={Plus}
            aria-label={m.conversation_attachment_label()}
            isDisabled={composerDisabled}
            className={cx("col-start-1", barRow, stacked && "mt-1")}
          />
        </FileTrigger>
        <ComposerSendButton
          asTask={asTask}
          taskMode={taskMode}
          isDisabled={sendDisabled}
          onChoose={(wantTask) => {
            submit(wantTask);
            // The closing menu hands focus back to its trigger; take it back after.
            requestAnimationFrame(focusComposer);
          }}
          className={cx("col-start-3", barRow, stacked && "mt-1")}
        />
      </div>
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
    </form>
  );
}
