import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image01, XClose } from "@untitledui/icons";
import { ARTIFACT_COMMENT_IMAGES_MAX, COMMENT_BODY_MAX } from "@lrm/coforge-sdk/agent";
import { readMessageReferences } from "@lrm/coforge-sdk/internal/message-references";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ComposerField } from "#src/features/conversations/composer-field";
import type { Mentionable } from "#src/features/conversations/mention-text";
import {
  COMMENT_FIELD_CLASS,
  COMMENT_FIELD_LAYOUT_CLASS,
} from "#src/features/conversations/review-chrome";
import {
  addMentionPin,
  mentionPinFor,
  pinsInText,
  rewriteMentionPins,
  type MentionPin,
} from "#src/features/conversations/mention-pins";
import { INLINE_IMAGE_TYPES } from "#src/features/conversations/paste-image";
import { useComposerPaste } from "#src/features/conversations/use-composer-paste";
import { useReferenceCompletion } from "#src/features/conversations/use-reference-completion";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppError } from "#src/lib/app-error";
import { ARTIFACT_RATE_LIMITED_ERROR_ID } from "./artifact-rate-limited";
import { formatList } from "#src/lib/format-list";
import { useDebouncedValue } from "#src/lib/use-debounced-value";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { postArtifactComment, previewArtifactCommentAudience } from "./artifact-comments.functions";
import { ComposerActions } from "./artifact-comment-composer-actions";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import { useArtifactCommenting } from "./artifact-commenting";
import { useHoldComposer } from "./artifact-composer-holds";
import { draftFailure } from "./use-comment-drafts";
import { COMMENT_MENTIONS_MAX, type CommentAnchor } from "./artifact-comment-inputs";
import { uploadCommentImage } from "./artifact-comment-images";
import { artifactMentionCandidatesQuery, syncOwnComments } from "./artifact-comment-queries";
import { ARTIFACTS_KEY } from "./artifact-queries";

export type CommentReplyTarget = { id: string; name: string };

export type ComposerTarget =
  | { kind: "panel"; version: number }
  | { kind: "file"; version: number; path: string; onClear: () => void }
  | { kind: "reply"; id: string; name: string; onCancel: () => void }
  | {
      kind: "anchor";
      version: number;
      path: string;
      anchor: CommentAnchor;
      header: ReactNode;
      suggestion?: string | undefined;
    };

type Attachment = {
  key: string;
  previewUrl: string;
  state: "uploading" | "ready" | "failed";
  sha256?: string;
};

const AUDIENCE_DELAY_MS = 350;

function useMentionables(artifactId: string) {
  const { data } = useQuery(artifactMentionCandidatesQuery(artifactId));
  return useMemo(() => {
    if (!data) return { offered: undefined, known: undefined };
    const toMentionable =
      (kind: Mentionable["kind"]) =>
      (candidate: { id: string; handle: string; name: string }): Mentionable => ({
        kind,
        id: candidate.id,
        handle: candidate.handle,
        label: candidate.name,
        description: "",
        mentionScore: 0,
      });
    const people = data.people.map(toMentionable("user"));
    const agents = data.agents.map(toMentionable("agent"));
    return {
      offered: {
        people: people.filter((person) => person.id !== data.viewerId),
        agents,
      },
      known: [...people, ...agents],
    };
  }, [data]);
}

export function useKnownMentionables(artifactId: string) {
  return useMentionables(artifactId).known;
}

export function useCommentDraftText(artifactId: string, initial = "") {
  const { offered } = useMentionables(artifactId);
  const [body, setBody] = useState(initial);
  const [pins, setPins] = useState<readonly MentionPin[]>([]);

  const changeBody = (value: string) => {
    setBody(value);
    setPins((current) => pinsInText(value, current));
  };
  const resetBody = (value = "") => {
    setBody(value);
    setPins([]);
  };
  const completion = useReferenceCompletion({
    mentionables: offered?.people,
    mentionOutsiders: offered?.agents,
    value: body,
    onChange: changeBody,
    onPickMention: (mention) =>
      setPins((current) => addMentionPin(current, mentionPinFor(mention))),
  });

  const wire = useMemo(() => rewriteMentionPins(body, pins), [body, pins]);
  const tooLong = wire.body.length > COMMENT_BODY_MAX;
  const mentions = useMemo(
    () => [...new Set(readMessageReferences(wire.body).candidates.handles)].sort().join(","),
    [wire.body],
  );
  const settledMentions = useDebouncedValue(mentions, AUDIENCE_DELAY_MS);
  const audience = useQuery({
    queryKey: [...ARTIFACTS_KEY, "audience", artifactId, settledMentions],
    queryFn: () => previewArtifactCommentAudience({ data: { artifactId, body: wire.body } }),
    enabled: !tooLong && settledMentions === mentions,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });

  const blocked =
    mentions !== "" && audience.data && !audience.isPlaceholderData && settledMentions === mentions
      ? audience.data
      : undefined;
  const mentionError = blocked?.tooMany
    ? m.av_cm_err_too_many_mentions({ count: COMMENT_MENTIONS_MAX })
    : blocked && blocked.cannotSee.length > 0
      ? m.av_cm_err_cannot_see({
          names: formatList(blocked.cannotSee.map((handle) => `@${handle}`)),
        })
      : null;

  return {
    body,
    wireBody: wire.body,
    changeBody,
    resetBody,
    completion,
    audience,
    tooLong,
    mentionError,
  };
}

const placement = (target: ComposerTarget) => {
  if (target.kind === "reply") return { replyTo: target.id };
  if (target.kind === "anchor") return { path: target.path, anchor: target.anchor };
  if (target.kind === "file") return { path: target.path };
  return {};
};

export function ArtifactCommentComposer({
  artifactId,
  target,
  focusRequest = 0,
  className,
  onPosted,
}: {
  artifactId: string;
  target: ComposerTarget;
  focusRequest?: number;
  className?: string;
  onPosted: () => void;
}) {
  const queryClient = useQueryClient();
  const workspaceSlug = useWorkspaceSlug();
  const drafts = useCommentDrafts();
  const { create: createDraft } = useCommentDraftActions();
  const { version: shownVersion } = useArtifactCommenting();
  const [saving, setSaving] = useState(false);
  const { body, wireBody, changeBody, resetBody, completion, audience, tooLong, mentionError } =
    useCommentDraftText(artifactId, target.kind === "anchor" ? (target.suggestion ?? "") : "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attempt = useRef({ signature: "", key: "" });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusRequest > 0) completion.textareaRef.current?.focus();
  }, [focusRequest, completion.textareaRef]);
  const replyId = target.kind === "reply" ? target.id : null;
  useEffect(() => {
    if (replyId !== null) completion.textareaRef.current?.focus();
  }, [replyId, completion.textareaRef]);

  const uploading = attachments.some((attachment) => attachment.state === "uploading");
  const ready = attachments.flatMap((attachment) =>
    attachment.state === "ready" && attachment.sha256 ? [attachment.sha256] : [],
  );
  const empty = body.trim() === "" && ready.length === 0;
  const invalid = empty || uploading || tooLong || mentionError !== null;
  const cannotSend = invalid || sending || drafts.busy;
  const cannotSave = invalid || saving || sending || drafts.busy || drafts.atLimit;
  const hasDrafts = drafts.drafts.length > 0;
  useHoldComposer(!empty || attachments.length > 0);

  function addFiles(files: readonly File[]) {
    const images = files.filter((file) => INLINE_IMAGE_TYPES.has(file.type));
    const room = ARTIFACT_COMMENT_IMAGES_MAX - attachments.length;
    if (images.length === 0) return;
    if (images.length > room)
      setFailure(m.av_cm_images_max({ count: ARTIFACT_COMMENT_IMAGES_MAX }));
    else setFailure(null);
    for (const file of images.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      setAttachments((current) => [...current, { key, previewUrl, state: "uploading" }]);
      uploadCommentImage(workspaceSlug, artifactId, file)
        .then((sha256) =>
          setAttachments((current) =>
            current.map((entry) =>
              entry.key === key ? { ...entry, state: "ready", sha256 } : entry,
            ),
          ),
        )
        .catch(() => {
          setAttachments((current) => current.filter((entry) => entry.key !== key));
          URL.revokeObjectURL(previewUrl);
          setFailure(m.av_cm_image_failed());
        });
    }
  }

  function removeAttachment(key: string) {
    setAttachments((current) => {
      const gone = current.find((entry) => entry.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return current.filter((entry) => entry.key !== key);
    });
  }

  const paste = useComposerPaste(
    Math.max(0, ARTIFACT_COMMENT_IMAGES_MAX - attachments.length),
    addFiles,
  );

  function clear() {
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    resetBody();
    setAttachments([]);
  }

  async function saveDraft() {
    if (cannotSave) return;
    setSaving(true);
    setFailure(null);
    try {
      await createDraft({
        version: target.kind === "reply" ? shownVersion : target.version,
        body: wireBody,
        ...placement(target),
        ...(ready.length ? { images: ready } : {}),
      });
      clear();
      onPosted();
    } catch (error) {
      setFailure(draftFailure(error));
    } finally {
      setSaving(false);
      completion.textareaRef.current?.focus();
    }
  }

  async function submit() {
    if (cannotSend) return;
    setSending(true);
    setFailure(null);
    const comment = {
      body: wireBody,
      ...placement(target),
      ...(ready.length ? { images: ready } : {}),
    };
    const version = target.kind === "reply" ? undefined : target.version;
    const signature = JSON.stringify([comment, version ?? null]);
    if (attempt.current.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    try {
      const { id } = await postArtifactComment({
        data: {
          artifactId,
          ...(version === undefined ? {} : { version }),
          comment: { ...comment, idempotencyKey: attempt.current.key },
        },
      });
      clear();
      onPosted();
      await syncOwnComments(queryClient, artifactId, "posted", [id]);
    } catch (error) {
      setFailure(commentWriteFailure(error, m.av_cm_err_send()));
    } finally {
      setSending(false);
      completion.textareaRef.current?.focus();
    }
  }

  const names = audience.data?.notified ?? [];
  const notifyLine =
    audience.data && !empty && names.length
      ? m.av_cm_will_notify({ names: formatList(names) })
      : null;
  const error = tooLong
    ? m.av_cm_err_too_long({ count: COMMENT_BODY_MAX })
    : (mentionError ?? failure ?? (drafts.atLimit ? m.av_dr_limit({ count: drafts.limit }) : null));

  return (
    <form
      className={cn("shrink-0 space-y-2 border-t border-secondary p-3", className)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {target.kind === "reply" ? (
        <ComposerChip
          label={m.av_cm_replying_to({ name: target.name })}
          onRemove={target.onCancel}
          removeLabel={m.av_cm_cancel_reply()}
        />
      ) : target.kind === "anchor" ? (
        target.header
      ) : (
        target.kind === "file" && (
          <ComposerChip
            label={m.av_cm_on_file({ path: target.path })}
            onRemove={target.onClear}
            removeLabel={m.av_cm_clear_target()}
          />
        )
      )}
      {target.kind === "anchor" && target.suggestion !== undefined && (
        <p data-page-suggested="" className="text-xs text-tertiary">
          {m.av_cm_page_suggested()}
        </p>
      )}
      <div className={target.kind === "anchor" ? COMMENT_FIELD_LAYOUT_CLASS : COMMENT_FIELD_CLASS}>
        <ComposerField
          completion={completion}
          value={body}
          onValueChange={changeBody}
          label={m.av_cm_field_label()}
          placeholder={
            target.kind === "reply" ? m.av_cm_reply_placeholder() : m.av_cm_placeholder()
          }
          onSubmit={() => void (hasDrafts ? saveDraft() : submit())}
          sendDisabled={cannotSend}
          isReadOnly={sending}
          mentionGroups="kind"
          alwaysStacked
          attachmentCount={attachments.length}
          onPaste={paste}
          leading={(className) => (
            <ButtonUtility
              icon={Image01}
              size="xs"
              color="tertiary"
              className={className}
              tooltip={m.av_cm_add_image()}
              isDisabled={attachments.length >= ARTIFACT_COMMENT_IMAGES_MAX}
              onClick={() => fileInput.current?.click()}
            />
          )}
          actions={(className) => (
            <ComposerActions
              className={className}
              hasDrafts={hasDrafts}
              canSend={!cannotSend}
              canSave={!cannotSave}
              sending={sending}
              saving={saving}
              onSave={() => void saveDraft()}
            />
          )}
          below={
            attachments.length > 0 && (
              <ul className="col-span-full row-start-2 flex flex-wrap gap-2 px-2 pt-1">
                {attachments.map((attachment) => (
                  <li key={attachment.key} className="relative">
                    <img
                      src={attachment.previewUrl}
                      alt={m.av_cm_image_alt()}
                      className={cn(
                        "size-14 rounded-md border border-secondary object-cover",
                        attachment.state === "uploading" && "opacity-50",
                      )}
                    />
                    <ButtonUtility
                      icon={XClose}
                      size="xs"
                      color="secondary"
                      className="absolute -top-2 -right-2 rounded-full"
                      tooltip={m.av_cm_remove_image()}
                      onClick={() => removeAttachment(attachment.key)}
                    />
                  </li>
                ))}
              </ul>
            )
          }
        />
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={[...INLINE_IMAGE_TYPES].join(",")}
        multiple
        hidden
        data-testid="artifact-comment-image-input"
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-error-primary">
          {error}
        </p>
      ) : (
        notifyLine && <p className="text-xs text-tertiary">{notifyLine}</p>
      )}
    </form>
  );
}

function ComposerChip({
  label,
  removeLabel,
  onRemove,
}: {
  label: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex min-w-0">
      <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-quaternary py-0.5 pr-0.5 pl-2 text-xs font-medium text-secondary">
        <span className="min-w-0 truncate">{label}</span>
        <ButtonUtility
          icon={XClose}
          size="xs"
          color="tertiary"
          className="shrink-0"
          tooltip={removeLabel}
          onClick={onRemove}
        />
      </span>
    </div>
  );
}

export function commentWriteFailure(error: unknown, fallback: string): string {
  if (isAppError(error)) {
    if (error.errorId === "artifact-too-many-mentions")
      return m.av_cm_err_too_many_mentions({ count: COMMENT_MENTIONS_MAX });
    if (error.errorId === "artifact-mention-cannot-see") {
      const names = String(error.details?.names ?? "")
        .split(",")
        .filter(Boolean)
        .map((handle) => `@${handle}`);
      if (names.length) return m.av_cm_err_cannot_see({ names: formatList(names) });
    }
    if (error.errorId === ARTIFACT_RATE_LIMITED_ERROR_ID)
      return m.av_cm_err_rate_limited({ seconds: Number(error.details?.retryAfterSeconds ?? 60) });
  }
  return fallback;
}
