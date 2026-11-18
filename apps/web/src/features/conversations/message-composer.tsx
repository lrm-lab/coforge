import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useHydrated } from "@tanstack/react-router";
import type { TaskPriorityLevel } from "@lrm/coforge-sdk/internal";

import { Plus, UploadCloud02 } from "@untitledui/icons";
import { FileTrigger } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { localId, composerPlaceholder } from "./composer-behavior";
import { ComposerField, focusDraftEnd } from "./composer-field";
import { COMPOSER_FOCUS_CLASS, COMPOSER_FRAME_CLASS } from "./composer-frame";
import { ComposerNotice } from "./composer-notice";
import { useLongMessage } from "./use-long-message";
import { ComposerAttachmentTray } from "./composer-attachment-tray";
import { useComposerAttachments } from "./use-composer-attachments";
import { useComposerPaste } from "./use-composer-paste";
import { useFileDrop } from "./use-file-drop";
import { useComposerScope } from "./composer-scope";
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
  autoFocus = true,
  hostRef,
}: {
  conversationId: string;
  threadRootId?: string;
  inThread: boolean;
  target?: string;
  mentionables?: readonly Mentionable[];
  mentionOutsiders?: readonly Mentionable[];
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
        body: string;
        idempotencyKey: string;
        asTask: boolean;
        taskPriority?: TaskPriorityLevel;
      }
    | undefined
  >(undefined);
  const [body, setBody] = useState(() => readComposerDraft(draftKey));
  const [pins, setPins] = useState(() => readComposerDraftPins(draftKey));
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
        handles: new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(
          unresolvedHandles.map((handle) => `@${handle}`),
        ),
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
  const [asTask, setAsTask] = useState(false);
  const [taskPriority, setTaskPriority] = useLastTaskPriority();
  useEffect(() => setAsTask(false), [draftKey]);
  const consumedQuoteIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!quotedDraft || quotedDraft.id === consumedQuoteIdRef.current) return;
    consumedQuoteIdRef.current = quotedDraft.id;
    setBody((current) => {
      const kept = current.replace(/\s+$/u, "");
      return kept ? `${kept}\n\n${quotedDraft.text}\n\n` : `${quotedDraft.text}\n\n`;
    });
    retryRef.current = undefined;
    requestAnimationFrame(focusComposer);
  }, [quotedDraft]);
  const composerDisabled = !hydrated;
  const drop = useFileDrop(composerDisabled || uploading, (files) => void addFiles(files));
  const paste = useComposerPaste(
    room,
    (files) => void addFiles(files),
    (text) => longMessage.pasted(text),
  );
  const taskMode = !inThread && Boolean(canSendAsTask);
  const sendDisabled =
    composerDisabled || uploading || anyFailed || (!body.trim() && attachments.length === 0);
  const placeholder = composerPlaceholder(inThread, target);
  const longMessage = useLongMessage({ body, setBody, addFiles, uploading, anyFailed, submit });

  function pinMention(mention: Mentionable) {
    setPins((current) => addMentionPin(current, mentionPinFor(mention)));
  }

  function returnFocusToComposer() {
    completion.textareaRef.current?.focus({ preventScroll: true });
  }

  function focusComposer() {
    focusDraftEnd(completion.textareaRef.current);
  }

  useEffect(() => {
    if (autoFocus && hydrated && window.matchMedia("(pointer: fine)").matches) focusComposer();
  }, [autoFocus, draftKey, hydrated]);
  useEffect(() => {
    if (!hostRef) return;
    const field = completion.textareaRef.current;
    hostRef.current = field;
    return () => {
      if (hostRef.current === field) hostRef.current = null;
    };
  }, [hostRef, completion.textareaRef]);

  function submit() {
    if (sendDisabled || longMessage.divert()) return;
    const text =
      body.trim() || longMessage.emptyBody(attachments) || attachments[0]?.file.name || "";
    const sendAsTask = taskMode && asTask;
    const sendPriority = sendAsTask ? taskPriority : undefined;
    const idempotencyKey =
      retryRef.current?.body === text &&
      retryRef.current.asTask === sendAsTask &&
      retryRef.current.taskPriority === sendPriority
        ? retryRef.current.idempotencyKey
        : localId();
    const uploaded = attachments.filter((item) => item.id);
    const message: OutgoingMessage = {
      localId: localId(),
      draftKey,
      body: text,
      pins: pinsInText(text, pins),
      idempotencyKey,
      asTask: sendAsTask,
      ...(sendPriority && { taskPriority: sendPriority }),
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
    setAttachments(() => []);
    setAsTask(false);
    focusComposer();
    outbox.send(message, uploaded);
  }

  useComposerRequests(draftKey, (request) => {
    if (request.kind === "focus") {
      focusComposer();
      return;
    }
    setBody((current) => draftWithUnsentMessage(current, request.body));
    setPins((current) => request.pins.reduce(addMentionPin, current));
    setAttachments((current) => [...request.chips, ...current]);
    setAsTask(request.asTask);
    if (request.taskPriority) setTaskPriority(request.taskPriority);
    retryRef.current = {
      body: request.body,
      idempotencyKey: request.idempotencyKey,
      asTask: request.asTask,
      taskPriority: request.asTask ? (request.taskPriority ?? readLastTaskPriority()) : undefined,
    };
    requestAnimationFrame(focusComposer);
  });

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
      <p role="status" className="sr-only">
        {unresolvedNotice}
      </p>
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
            setKeptAsText((current) => new Set(current).add(unpinned.label));
            returnFocusToComposer();
          }}
        />
      )}
      <ComposerField
        completion={completion}
        value={body}
        onValueChange={(value) => {
          setBody(value);
          if (retryRef.current && value.trim() !== retryRef.current.body)
            retryRef.current = undefined;
        }}
        label={m.conversation_message_label()}
        placeholder={placeholder}
        onSubmit={submit}
        onTaskMode={setAsTask}
        sendDisabled={sendDisabled}
        isDisabled={composerDisabled}
        taskMode={taskMode}
        asTask={asTask}
        attachmentCount={attachments.length}
        onPaste={paste}
        below={attachments.length > 0 && <ComposerAttachmentTray {...tray} />}
        leading={(className) => (
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
              className={className}
            />
          </FileTrigger>
        )}
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
