import { useSendAsTask } from "./conversation-view-memory";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useHydrated } from "@tanstack/react-router";
import type { TaskPriorityLevel } from "@lrm/coforge-sdk/internal";

import { Clock, Plus, UploadCloud02 } from "@untitledui/icons";
import { FileTrigger } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { listFormat } from "#src/lib/intl";
import { localId, composerPlaceholder } from "./composer-behavior";
import { ComposerField, focusDraftEnd } from "./composer-field";
import { COMPOSER_FOCUS_CLASS, COMPOSER_FRAME_CLASS } from "./composer-frame";
import { ComposerNotice } from "./composer-notice";
import { useLongMessage } from "./use-long-message";
import { composerSendDisabled, composerSendPress } from "./composer-send-gate";
import { ComposerAttachmentTray } from "./composer-attachment-tray";
import { pendingAttachmentName } from "./composer-attachments";
import { useComposerAttachments } from "./use-composer-attachments";
import { useComposerPaste } from "./use-composer-paste";
import { useFileDrop } from "./use-file-drop";
import { useComposerScope } from "./composer-scope";
import {
  draftWithUnsentMessage,
  resolveSubmitIdempotencyKey,
  type OutgoingMessage,
  type SendOptions,
} from "./composer-outbox";
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
  type MentionPin,
} from "./mention-pins";
import type { ChannelSuggestion } from "./reference-completion";
import { useReferenceCompletion } from "./use-reference-completion";
import { PendingMentionStrip, type PendingMention } from "./pending-mention-strip";
import { UnpinnedMentionHint } from "./unpinned-mention-hint";
import { ComposerTaskPriority } from "./composer-task-priority";
import {
  readLastTaskPriority,
  useLastTaskPriority,
} from "#src/features/settings/last-task-priority";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

export type SentMessage = {
  id: string;
  sequence: number;
  body: string;
  createdAt: Date | string;
  unresolvedMentionHandles?: readonly string[];
  pendingMentionActions?: readonly PendingMention[];
};

const NO_NAMES: ReadonlySet<string> = new Set();

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type ComposerDraftState = {
  key: string;
  body: string;
  pins: readonly MentionPin[];
};

function readDraftState(key: string): ComposerDraftState {
  return {
    key,
    body: readComposerDraft(key),
    pins: readComposerDraftPins(key),
  };
}

const ComposerAttachmentTrigger = memo(function ComposerAttachmentTrigger({
  className,
  isDisabled,
  onFiles,
}: {
  className: string;
  isDisabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const handleSelect = useCallback(
    (list: FileList | null) => {
      const files = Array.from(list ?? []);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );
  return (
    <FileTrigger allowsMultiple onSelect={handleSelect}>
      <Button
        color="tertiary"
        size="xs"
        iconLeading={Plus}
        aria-label={m.conversation_attachment_label()}
        isDisabled={isDisabled}
        className={`${className} any-pointer-coarse:after:absolute any-pointer-coarse:after:-inset-2`}
      />
    </FileTrigger>
  );
});

export function MessageComposer({
  conversationId,
  threadRootId,
  inThread,
  target,
  mentionables,
  mentionOutsiders,
  mentionMemberLimit,
  recentHandles,
  channels,
  quotedDraft,
  onSend,
  canSendAsTask,
  autoFocus = true,
  hostRef,
}: {
  conversationId: string;
  threadRootId?: string;
  inThread: boolean;
  target?: string;
  mentionables?: readonly Mentionable[];
  mentionOutsiders?: readonly Mentionable[];
  mentionMemberLimit?: number;
  recentHandles?: readonly string[];
  channels?: readonly ChannelSuggestion[];
  quotedDraft?: { id: number; text: string };
  onSend: (
    body: string,
    idempotencyKey: string,
    attachmentIds?: string[],
    options?: SendOptions,
  ) => Promise<SentMessage | void>;
  canSendAsTask?: boolean;
  autoFocus?: boolean;
  hostRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const hydrated = useHydrated();
  const scope = useComposerScope();
  const draftKey = scope?.draftKey ?? composerDraftKey(conversationId, threadRootId);
  const retryRef = useRef<
    | {
        draftKey: string;
        body: string;
        idempotencyKey: string;
        asTask: boolean;
        taskPriority?: TaskPriorityLevel;
        attachmentIds: readonly string[];
      }
    | undefined
  >(undefined);
  const [draft, setDraft] = useState(() => readDraftState(draftKey));
  const shown = useMemo(
    () => (draft.key === draftKey ? draft : readDraftState(draftKey)),
    [draft, draftKey],
  );
  const { body, pins } = shown;
  const [keptState, setKeptState] = useState<{
    draftKey: string;
    names: ReadonlySet<string>;
  }>(() => ({ draftKey, names: NO_NAMES }));
  const keptAsText = keptState.draftKey === draftKey ? keptState.names : NO_NAMES;

  useEffect(() => {
    writeComposerDraft(draftKey, body);
  }, [draftKey, body]);
  useEffect(() => {
    writeComposerDraftPins(draftKey, pins);
  }, [draftKey, pins]);

  const updateBody = useLatestCallback((next: string) => {
    setDraft((current) => {
      const base = current.key === draftKey ? current : readDraftState(draftKey);
      return { key: draftKey, body: next, pins: pinsInText(next, base.pins) };
    });
    if (retryRef.current?.draftKey === draftKey && next.trim() !== retryRef.current.body)
      retryRef.current = undefined;
  });

  const pinMention = useLatestCallback((mention: Mentionable) => {
    setDraft((current) => {
      const base = current.key === draftKey ? current : readDraftState(draftKey);
      return {
        key: draftKey,
        body: base.body,
        pins: addMentionPin(base.pins, mentionPinFor(mention)),
      };
    });
  });

  const completion = useReferenceCompletion({
    mentionables,
    mentionOutsiders,
    mentionMemberLimit,
    recentHandles,
    channels,
    currentChannelId: conversationId,
    value: body,
    onChange: updateBody,
    onPickMention: pinMention,
  });
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
        handles: listFormat(getLocale()).format(unresolvedHandles.map((handle) => `@${handle}`)),
      })
    : "";
  const outbox = useMessageOutbox({
    draftKey,
    onSend,
    onSent: (message) => {
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
  const { attachments, setAttachments, uploading, anyFailed, room, addFiles, tray } =
    useComposerAttachments(draftKey, scope?.uploadTo ?? (() => Promise.resolve(conversationId)));
  const [asTask, setAsTask] = useSendAsTask(draftKey);
  const [taskPriority, setTaskPriority] = useLastTaskPriority();
  const consumedQuoteIdRef = useRef<number | undefined>(undefined);
  const focusComposer = useLatestCallback(() => {
    focusDraftEnd(completion.textareaRef.current);
  });
  useEffect(() => {
    if (!quotedDraft || quotedDraft.id === consumedQuoteIdRef.current) return;
    consumedQuoteIdRef.current = quotedDraft.id;
    setDraft((current) => {
      const base = current.key === draftKey ? current : readDraftState(draftKey);
      const kept = base.body.replace(/\s+$/u, "");
      const nextBody = kept ? `${kept}\n\n${quotedDraft.text}\n\n` : `${quotedDraft.text}\n\n`;
      return { key: draftKey, body: nextBody, pins: pinsInText(nextBody, base.pins) };
    });
    retryRef.current = undefined;
    requestAnimationFrame(focusComposer);
  }, [quotedDraft, draftKey, focusComposer]);
  const composerDisabled = !hydrated;
  const handleAddFiles = useLatestCallback((files: File[]) => {
    void addFiles(files);
  });
  const submitRef = useRef<(options?: { fromQueuedUpload?: boolean }) => void>(() => {});
  const runSubmit = useCallback(
    (options?: { fromQueuedUpload?: boolean }) => submitRef.current(options),
    [],
  );
  const longMessage = useLongMessage({
    draftKey,
    body,
    setBody: updateBody,
    addFiles,
    uploading,
    anyFailed,
    submit: runSubmit,
  });
  const drop = useFileDrop(composerDisabled || uploading, handleAddFiles);
  const paste = useComposerPaste(room, handleAddFiles, (text) => longMessage.pasted(text));
  const taskMode = !inThread && Boolean(canSendAsTask);
  const placeholder = scope?.placeholder ?? composerPlaceholder(inThread, target);
  const sendState = {
    hydrated,
    uploading,
    anyFailed,
    hasContent: Boolean(body.trim()) || attachments.length > 0,
    waiting: longMessage.waitingToSend,
  };
  const sendDisabled = composerSendDisabled(sendState);
  const waitingToSendNotice =
    longMessage.waitingToSend && uploading ? m.conversation_send_after_upload() : "";
  const statusAnnouncement = waitingToSendNotice || unresolvedNotice;

  function returnFocusToComposer() {
    completion.textareaRef.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (autoFocus && hydrated && window.matchMedia("(pointer: fine)").matches) focusComposer();
  }, [autoFocus, draftKey, hydrated, focusComposer]);
  useEffect(() => {
    if (!hostRef) return;
    const field = completion.textareaRef.current;
    hostRef.current = field;
    return () => {
      if (hostRef.current === field) hostRef.current = null;
    };
  }, [hostRef, completion.textareaRef]);

  function submit(options?: { fromQueuedUpload?: boolean }) {
    const action = composerSendPress({
      ...sendState,
      waiting: options?.fromQueuedUpload ? false : sendState.waiting,
    });
    if (action === "ignored") return;
    if (action === "after-uploads") {
      longMessage.sendAfterUploads();
      return;
    }
    if (longMessage.divert()) return;
    const text =
      body.trim() ||
      longMessage.emptyBody(attachments) ||
      (attachments[0] ? pendingAttachmentName(attachments[0]) : "");
    const sendAsTask = taskMode && asTask;
    const sendPriority = sendAsTask ? taskPriority : undefined;
    const uploaded = attachments.filter((item) => item.id);
    const uploadedIds = uploaded.flatMap((item) => (item.id ? [item.id] : []));
    const activeRetry = retryRef.current?.draftKey === draftKey ? retryRef.current : undefined;
    const idempotencyKey = resolveSubmitIdempotencyKey(
      activeRetry,
      {
        body: text,
        asTask: sendAsTask,
        taskPriority: sendPriority,
        attachmentIds: uploadedIds,
      },
      localId,
    );
    const message: OutgoingMessage = {
      localId: localId(),
      draftKey,
      body: text,
      pins: pinsInText(text, pins),
      idempotencyKey,
      asTask: sendAsTask,
      ...(sendPriority && { taskPriority: sendPriority }),
      attachments: uploaded.flatMap((item) =>
        item.id ? [{ id: item.id, fileName: pendingAttachmentName(item) }] : [],
      ),
    };
    retryRef.current = undefined;
    setDraft({ key: draftKey, body: "", pins: NO_PINS });
    setKeptState({ draftKey, names: NO_NAMES });
    clearComposerDraft(draftKey);
    completion.close();
    setAttachments(() => []);
    setAsTask(false);
    focusComposer();
    outbox.send(message, uploaded);
  }
  useIsomorphicLayoutEffect(() => {
    submitRef.current = submit;
  });

  useComposerRequests(draftKey, (request) => {
    if (request.kind === "focus") {
      focusComposer();
      return;
    }
    setDraft((current) => {
      const base = current.key === draftKey ? current : readDraftState(draftKey);
      const nextBody = draftWithUnsentMessage(base.body, request.body);
      const nextPins = pinsInText(nextBody, request.pins.reduce(addMentionPin, base.pins));
      return { key: draftKey, body: nextBody, pins: nextPins };
    });
    setAttachments((current) => [...request.chips, ...current]);
    setAsTask(request.asTask);
    if (request.taskPriority) setTaskPriority(request.taskPriority);
    retryRef.current = {
      draftKey,
      body: request.body,
      idempotencyKey: request.idempotencyKey,
      asTask: request.asTask,
      taskPriority: request.asTask ? (request.taskPriority ?? readLastTaskPriority()) : undefined,
      attachmentIds: request.attachmentIds,
    };
    requestAnimationFrame(focusComposer);
  });

  const renderLeading = useCallback(
    (className: string) => (
      <ComposerAttachmentTrigger
        className={className}
        isDisabled={composerDisabled}
        onFiles={handleAddFiles}
      />
    ),
    [composerDisabled, handleAddFiles],
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      {...drop.handlers}
      className={`${COMPOSER_FOCUS_CLASS} ${COMPOSER_FRAME_CLASS}`}
    >
      {drop.dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-secondary text-sm font-medium text-secondary">
          <UploadCloud02 aria-hidden="true" className="size-5 text-fg-quaternary" />
          {m.conversation_drop_to_upload()}
        </div>
      )}
      {pendingMentions.length > 0 && (
        <PendingMentionStrip
          key={current?.sequence}
          mentions={pendingMentions}
          onSettle={(resolutionIds, outcome) => {
            const settledIds = new Set(resolutionIds);
            setUnresolved(
              (report) =>
                report && {
                  ...report,
                  pendingMentions: report.pendingMentions.map((mention) =>
                    settledIds.has(mention.resolutionId) ? { ...mention, outcome } : mention,
                  ),
                },
            );
          }}
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
      <p role="status" className="sr-only">
        {statusAnnouncement}
      </p>
      {waitingToSendNotice && (
        <div
          data-composer-send-waiting
          className="flex items-center gap-2 px-2 text-sm text-tertiary"
        >
          <Clock aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
          <p aria-hidden="true" className="min-w-0 flex-1">
            {waitingToSendNotice}
          </p>
        </div>
      )}
      {unresolvedNotice && (
        <ComposerNotice
          text={unresolvedNotice}
          dismissLabel={m.conversation_unresolved_mentions_dismiss()}
          onDismiss={() => setUnresolved((report) => report && { ...report, handles: [] })}
        />
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
            setKeptState((current) => {
              const base = current.draftKey === draftKey ? current.names : NO_NAMES;
              return { draftKey, names: new Set(base).add(unpinned.label) };
            });
            returnFocusToComposer();
          }}
        />
      )}
      <ComposerField
        completion={completion}
        value={body}
        onValueChange={updateBody}
        label={m.conversation_message_label()}
        placeholder={placeholder}
        onSubmit={() => submit()}
        onTaskMode={setAsTask}
        sendDisabled={sendDisabled}
        isDisabled={composerDisabled}
        taskMode={taskMode}
        asTask={asTask}
        attachmentCount={attachments.length}
        onPaste={paste}
        below={
          attachments.length > 0 && (
            <ComposerAttachmentTray
              {...tray}
              remove={(localIds) => {
                longMessage.cancelWaitingSend();
                tray.remove(localIds);
              }}
            />
          )
        }
        leading={renderLeading}
      />
      {taskMode && asTask && (
        <ComposerTaskPriority
          priority={taskPriority}
          disabled={composerDisabled}
          onSelect={setTaskPriority}
        />
      )}
    </form>
  );
}
