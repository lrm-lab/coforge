import { useCallback, useEffect, useRef, useState } from "react";
import { Cursor02 } from "@untitledui/icons";

import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { isRecordingShortcut } from "#src/features/shortcuts/shortcut-bindings";
import { m } from "#src/paraglide/messages";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import { hasImages, type CommentDraftView } from "./artifact-comment-drafts-queries";
import { useArtifactCommenting } from "./artifact-commenting";
import {
  ArtifactInlineEditor,
  segmentsFromDraft,
  type ArtifactInlineEditorHandle,
} from "./artifact-inline-editor";
import {
  elementAnchorsFromSegments,
  firstElementAnchorFromSegments,
  serializeInlineSegments,
  type InlineSegment,
} from "./artifact-inline-refs";
import {
  AnchorChip,
  ArtifactReviewBar,
  ArtifactReviewQueue,
  formatAnchorTag,
} from "./artifact-review-chrome";
import {
  ArtifactReviewComposeFooter,
  useImmediateReviewSend,
} from "./artifact-review-compose-footer";
import { draftFailure } from "./use-comment-drafts";
import "./artifact-review-pill.css";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return target.closest('[role="dialog"], [aria-modal="true"]') !== null;
}

function hasContent(segments: readonly InlineSegment[]): boolean {
  return segments.some((segment) => segment.kind === "element" || segment.text.trim() !== "");
}

export function ArtifactReviewPill({
  activePath,
  annotating,
  onToggleAnnotate,
  onExitAnnotate,
  onTogglePanel,
}: {
  activePath?: string | undefined;
  annotating: boolean;
  onToggleAnnotate: () => void;
  onExitAnnotate: () => void;
  onTogglePanel: () => void;
}) {
  const { artifactId, version, pickBus } = useArtifactCommenting();
  const drafts = useCommentDrafts();
  const actions = useCommentDraftActions();
  const [cardOpen, setCardOpen] = useState(false);
  const [cardView, setCardView] = useState<"list" | "compose">("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [segments, setSegments] = useState<InlineSegment[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [confirmDeleteDraft, setConfirmDeleteDraft] = useState<CommentDraftView | null>(null);
  const editorRef = useRef<ArtifactInlineEditorHandle>(null);
  const pickedPathRef = useRef<string | undefined>(undefined);
  const hydratedEditRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const prevAnnotatingRef = useRef(annotating);

  const count = drafts.drafts.length;
  const preferDraft = count > 0;
  const locked = drafts.busy;
  const editingDraft = editingId
    ? (drafts.drafts.find((item) => item.id === editingId) ?? null)
    : null;
  const active = annotating || count > 0 || editingDraft !== null;
  const showCard =
    cardOpen && active && (cardView === "compose" || editingDraft !== null || count > 0);
  const isCompose = editingDraft !== null || (showCard && cardView === "compose");

  useEffect(() => {
    if (!showCard || !isCompose) {
      hydratedEditRef.current = null;
      pickBus.setHighlightedAnchors([]);
      return;
    }
    if (editingDraft && hydratedEditRef.current !== editingDraft.id) {
      hydratedEditRef.current = editingDraft.id;
      pickedPathRef.current = editingDraft.path ?? activePath;
      editorRef.current?.setSegments(segmentsFromDraft(editingDraft));
      return;
    }
    if (!editingDraft) {
      hydratedEditRef.current = null;
      editorRef.current?.focus();
    }
  }, [showCard, isCompose, editingDraft, activePath, pickBus]);

  useEffect(() => {
    if (!showCard || !isCompose) {
      pickBus.setPickHandler(null);
      return;
    }
    pickBus.setPickHandler((picked) => {
      pickedPathRef.current = picked.path;
      editorRef.current?.insertElement({
        tag: picked.tag,
        selector: picked.selector,
        ...(picked.quote ? { quote: picked.quote } : {}),
      });
    });
    return () => pickBus.setPickHandler(null);
  }, [showCard, isCompose, pickBus]);

  const handleSegmentsChange = useCallback(
    (next: InlineSegment[]) => {
      setSegments(next);
      pickBus.setHighlightedAnchors(elementAnchorsFromSegments(next));
    },
    [pickBus],
  );

  const resetCompose = useCallback(() => {
    setEditingId(null);
    setSegments([]);
    setSaveError(null);
    pickedPathRef.current = undefined;
    hydratedEditRef.current = null;
    editorRef.current?.clear();
    pickBus.setHighlightedAnchors([]);
  }, [pickBus]);

  const openQueue = useCallback(() => {
    resetCompose();
    setCardView("list");
    setCardOpen(true);
    if (annotating) onExitAnnotate();
  }, [resetCompose, annotating, onExitAnnotate]);

  const collapseQueue = useCallback(() => {
    setFocusedIdx(-1);
    setCardOpen(false);
  }, []);

  const enterCompose = useCallback(() => {
    resetCompose();
    setFocusedIdx(-1);
    setCardView("compose");
    setCardOpen(true);
    if (!annotating) onToggleAnnotate();
  }, [resetCompose, annotating, onToggleAnnotate]);

  const exitComposeToList = useCallback(() => {
    resetCompose();
    setCardView("list");
    if (annotating) onExitAnnotate();
    if (count === 0) setCardOpen(false);
  }, [resetCompose, annotating, onExitAnnotate, count]);

  useEffect(() => {
    const prev = prevAnnotatingRef.current;
    prevAnnotatingRef.current = annotating;
    if (!prev && annotating && cardOpen && cardView === "list" && !editingDraft) {
      setCardOpen(false);
      return;
    }
    if (prev && !annotating && !editingDraft && cardView === "compose") {
      resetCompose();
      setCardView("list");
      if (count === 0) setCardOpen(false);
    }
  }, [annotating, cardOpen, cardView, editingDraft, count, resetCompose]);

  const startEdit = useCallback(
    (draft: CommentDraftView) => {
      if (locked) return;
      hydratedEditRef.current = null;
      setEditingId(draft.id);
      setSaveError(null);
      setCardView("compose");
      setCardOpen(true);
      const canPickElements = draft.anchor === null || draft.anchor.type === "element";
      if (canPickElements && !annotating) onToggleAnnotate();
      else if (!canPickElements && annotating) onExitAnnotate();
    },
    [locked, annotating, onToggleAnnotate, onExitAnnotate],
  );

  const saveForm = useCallback(
    async (sendAfter = false) => {
      if (saving || locked || savingRef.current) return;
      const currentSegments = editorRef.current?.readSegments() ?? segments;
      const serialized = serializeInlineSegments(currentSegments);
      const primaryElement = firstElementAnchorFromSegments(currentSegments);

      if (editingDraft) {
        if (!serialized && editingDraft.images.length === 0) return;
        savingRef.current = true;
        setSaving(true);
        setSaveError(null);
        let saved = false;
        try {
          const canUpdateAnchor =
            editingDraft.anchor === null || editingDraft.anchor.type === "element";
          await actions.edit(
            editingDraft,
            serialized,
            canUpdateAnchor
              ? {
                  anchor: primaryElement,
                  ...(primaryElement
                    ? { path: pickedPathRef.current ?? editingDraft.path ?? activePath ?? null }
                    : {}),
                }
              : undefined,
          );
          resetCompose();
          setCardView("list");
          if (annotating) onExitAnnotate();
          saved = true;
        } catch (error) {
          setSaveError(draftFailure(error));
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
        if (saved && sendAfter) {
          setCardOpen(false);
          await actions.submit();
        }
        return;
      }

      if (!serialized) {
        if (sendAfter && count > 0) {
          resetCompose();
          setCardView("list");
          if (annotating) onExitAnnotate();
          setCardOpen(false);
          await actions.submit();
        }
        return;
      }
      if (drafts.atLimit) return;
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      let saved = false;
      try {
        const targetPath = primaryElement ? (pickedPathRef.current ?? activePath) : activePath;
        await actions.create({
          version,
          body: serialized,
          ...(targetPath ? { path: targetPath } : {}),
          ...(primaryElement ? { anchor: primaryElement } : {}),
        });
        resetCompose();
        setCardView("list");
        if (annotating) onExitAnnotate();
        saved = true;
      } catch (error) {
        setSaveError(draftFailure(error));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
      if (saved) {
        if (sendAfter) {
          setCardOpen(false);
          await actions.submit();
        } else {
          setCardOpen(true);
        }
      }
    },
    [
      saving,
      locked,
      segments,
      editingDraft,
      actions,
      activePath,
      resetCompose,
      annotating,
      onExitAnnotate,
      count,
      drafts.atLimit,
      version,
    ],
  );

  const sendImmediate = useImmediateReviewSend({
    artifactId,
    version,
    activePath,
    readSegments: useCallback(() => editorRef.current?.readSegments() ?? segments, [segments]),
    pickedPath: useCallback(() => pickedPathRef.current, []),
    busy: saving || locked || editingDraft !== null,
    onStart: useCallback(() => {
      setSaving(true);
      setSaveError(null);
    }, []),
    onError: setSaveError,
    onDone: useCallback(() => {
      resetCompose();
      setCardView("list");
      if (annotating) onExitAnnotate();
      if (count === 0) setCardOpen(false);
    }, [resetCompose, annotating, onExitAnnotate, count]),
    onFinally: useCallback(() => setSaving(false), []),
  });

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isRecordingShortcut() || isEditableTarget(event.target)) return;

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      if (active && !isCompose && count > 0 && !locked) {
        event.preventDefault();
        void actions.submit();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.shiftKey && (event.key === "C" || event.key === "c")) {
      event.preventDefault();
      onTogglePanel();
      return;
    }

    if (showCard && !isCompose && (event.key === "n" || event.key === "N")) {
      event.preventDefault();
      enterCompose();
      return;
    }

    if (event.key === "Escape") {
      if (isCompose) {
        event.preventDefault();
        exitComposeToList();
      } else if (showCard) {
        event.preventDefault();
        collapseQueue();
      } else if (annotating) {
        event.preventDefault();
        onExitAnnotate();
      }
      return;
    }

    if (!showCard || isCompose || count === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedIdx((index) => (index + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedIdx((index) => (index <= 0 ? count - 1 : index - 1));
    } else if ((event.key === "e" || event.key === "E") && focusedIdx >= 0 && focusedIdx < count) {
      event.preventDefault();
      const target = drafts.drafts[focusedIdx];
      if (target) startEdit(target);
    } else if (
      (event.key === "Backspace" || event.key === "Delete") &&
      focusedIdx >= 0 &&
      focusedIdx < count &&
      !locked
    ) {
      event.preventDefault();
      const target = drafts.drafts[focusedIdx];
      if (target) {
        if (hasImages(target)) {
          setConfirmDeleteDraft(target);
        } else {
          void actions.remove(target);
          setFocusedIdx((index) => Math.min(index, count - 2));
        }
      }
    }
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  if (!active) return null;

  const editorHasContent = hasContent(segments);
  const canSave = editingDraft
    ? (editorHasContent || editingDraft.images.length > 0) && !saving && !locked
    : editorHasContent && !saving && !locked && !drafts.atLimit;
  const canSend = !editingDraft && editorHasContent && !saving && !locked;

  return (
    <div
      data-artifact-review-pill=""
      className="pointer-events-none absolute inset-x-4 bottom-4 z-20 mx-auto flex max-w-[calc(100vw-2rem)] flex-col items-center gap-2"
    >
      {showCard ? (
        <div
          data-review-card=""
          className="artifact-review-card pointer-events-auto w-[23.5rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[1.125rem] bg-primary"
        >
          {isCompose ? (
            <>
              <div className="px-3.5 pt-3 pb-2.5">
                <div className="mb-2 flex items-center gap-1.5 text-xs text-tertiary select-none">
                  <Cursor02
                    aria-hidden="true"
                    strokeWidth={1.5}
                    className="size-3 shrink-0 text-fg-brand-primary"
                  />
                  <span>{m.av_cm_pick_hint()}</span>
                </div>
                {editingDraft?.anchor && editingDraft.anchor.type !== "element" && (
                  <div className="mb-2 flex items-center">
                    <AnchorChip label={formatAnchorTag(editingDraft.anchor, editingDraft.path)} />
                  </div>
                )}
                <ArtifactInlineEditor
                  ref={editorRef}
                  label={m.av_cm_field_label()}
                  placeholder={m.av_dr_compose_placeholder()}
                  disabled={saving || locked}
                  onSegmentsChange={handleSegmentsChange}
                  onSubmit={() => {
                    if (editingDraft || preferDraft) void saveForm(false);
                    else void sendImmediate();
                  }}
                  onSubmitAndSend={() => {
                    if (editingDraft) void saveForm(true);
                    else if (preferDraft) void sendImmediate();
                    else void saveForm(false);
                  }}
                  onCancel={exitComposeToList}
                />
                {saveError && (
                  <p role="alert" className="mt-1.5 text-xs text-error-primary">
                    {saveError}
                  </p>
                )}
              </div>
              <ArtifactReviewComposeFooter
                editing={editingDraft !== null}
                preferDraft={preferDraft}
                saving={saving}
                canSave={canSave}
                canSend={canSend}
                onCancel={exitComposeToList}
                onSaveDraft={() => void saveForm(false)}
                onSend={() => void sendImmediate()}
              />
            </>
          ) : (
            <ArtifactReviewQueue
              drafts={drafts.drafts}
              focusedIdx={focusedIdx}
              locked={locked}
              atLimit={drafts.atLimit}
              onOpenDraft={actions.openDraft}
              onEditDraft={startEdit}
              onRemoveDraft={(draft) => actions.remove(draft)}
              onCollapse={collapseQueue}
              onNewComment={enterCompose}
              onSubmit={() => void actions.submit()}
            />
          )}
        </div>
      ) : (
        <ArtifactReviewBar
          annotating={annotating}
          count={count}
          locked={locked}
          onExitAnnotate={onExitAnnotate}
          onOpenQueue={openQueue}
          onSubmit={() => void actions.submit()}
        />
      )}
      <ConfirmDialog
        open={confirmDeleteDraft !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteDraft(null);
        }}
        title={m.av_dr_delete_title()}
        description={m.av_dr_delete_body()}
        confirmLabel={m.av_dr_delete_confirm()}
        errorMessage={m.av_dr_delete_failed()}
        onConfirm={async () => {
          if (!confirmDeleteDraft) return;
          await actions.remove(confirmDeleteDraft);
          setConfirmDeleteDraft(null);
          setFocusedIdx((index) => Math.min(index, count - 2));
        }}
      />
    </div>
  );
}
