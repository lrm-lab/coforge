import { useCallback, useEffect, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Cursor02, Plus } from "@untitledui/icons";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { useAppToast } from "#src/components/ui/toast";
import { isRecordingShortcut } from "#src/features/shortcuts/shortcut-bindings";
import { hotkeyKeycaps, hotkeyMatchesEvent } from "#src/lib/hotkeys";
import { isApplePlatform } from "#src/lib/platform";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";
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
  ArtifactReviewFab,
  ArtifactReviewQueue,
  PRIMARY_PILL_CLASS,
  SECONDARY_PILL_CLASS,
  TooltipShortcutRows,
  TooltipWithKey,
  formatAnchorTag,
} from "./artifact-review-chrome";
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
  const { version, pickedAnchor, pickBus } = useArtifactCommenting();
  const drafts = useCommentDrafts();
  const actions = useCommentDraftActions();
  const [cardOpen, setCardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [segments, setSegments] = useState<InlineSegment[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [apple, setApple] = useState(false);
  const toast = useAppToast();
  const [hidden, setHidden] = useState(false);
  const restoreKey = useRef<string | null>(null);
  const taps = useRef<number[]>([]);
  const editorRef = useRef<ArtifactInlineEditorHandle>(null);
  const pickedPathRef = useRef<string | undefined>(undefined);
  const hydratedEditRef = useRef<string | null>(null);

  useEffect(() => {
    setApple(isApplePlatform());
    setHidden(localStorage.getItem("artifact-annotation-hidden") === "true");
  }, []);

  const modEnter = hotkeyKeycaps("Mod+Enter", apple).join(apple ? " " : "+");
  const count = drafts.drafts.length;
  const locked = drafts.busy;
  const editingDraft = editingId
    ? (drafts.drafts.find((item) => item.id === editingId) ?? null)
    : null;
  const isCompose = editingDraft !== null || annotating || pickedAnchor !== null;
  const showCard = !hidden && cardOpen && (isCompose || count > 0);
  const nonElementPicked =
    pickedAnchor && pickedAnchor.anchor.type !== "element" ? pickedAnchor : null;

  useEffect(() => {
    if (annotating || pickedAnchor) setCardOpen(true);
  }, [annotating, pickedAnchor]);

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

  const enterCompose = useCallback(() => {
    resetCompose();
    setFocusedIdx(-1);
    setCardOpen(true);
    if (!annotating) onToggleAnnotate();
  }, [resetCompose, annotating, onToggleAnnotate]);

  const exitComposeToList = useCallback(() => {
    resetCompose();
    pickedAnchor?.onClear();
    if (annotating) onExitAnnotate();
    if (count === 0) setCardOpen(false);
  }, [resetCompose, pickedAnchor, annotating, onExitAnnotate, count]);

  const startEdit = useCallback(
    (draft: CommentDraftView) => {
      if (locked) return;
      pickedAnchor?.onClear();
      hydratedEditRef.current = null;
      setEditingId(draft.id);
      setSaveError(null);
      setCardOpen(true);
      const canPickElements = draft.anchor === null || draft.anchor.type === "element";
      if (canPickElements && !annotating) onToggleAnnotate();
      else if (!canPickElements && annotating) onExitAnnotate();
    },
    [locked, pickedAnchor, annotating, onToggleAnnotate, onExitAnnotate],
  );

  const saveForm = useCallback(
    async (sendAfter = false) => {
      if (saving || locked) return;
      const currentSegments = editorRef.current?.readSegments() ?? segments;
      const serialized = serializeInlineSegments(currentSegments);
      const primaryElement = firstElementAnchorFromSegments(currentSegments);

      if (editingDraft) {
        if (!serialized && editingDraft.images.length === 0) return;
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
          if (annotating) onExitAnnotate();
          saved = true;
        } catch (error) {
          setSaveError(draftFailure(error));
        } finally {
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
          pickedAnchor?.onClear();
          if (annotating) onExitAnnotate();
          setCardOpen(false);
          await actions.submit();
        }
        return;
      }
      if (drafts.atLimit) return;
      setSaving(true);
      setSaveError(null);
      let saved = false;
      try {
        const targetAnchor = nonElementPicked ? nonElementPicked.anchor : primaryElement;
        const targetPath = nonElementPicked
          ? nonElementPicked.path
          : targetAnchor
            ? (pickedPathRef.current ?? activePath)
            : activePath;
        await actions.create({
          version: nonElementPicked?.version ?? version,
          body: serialized,
          ...(targetPath ? { path: targetPath } : {}),
          ...(targetAnchor ? { anchor: targetAnchor } : {}),
        });
        resetCompose();
        pickedAnchor?.onClear();
        if (annotating) onExitAnnotate();
        saved = true;
      } catch (error) {
        setSaveError(draftFailure(error));
      } finally {
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
      nonElementPicked,
      version,
      pickedAnchor,
    ],
  );

  const toggleVisibility = useCallback(() => {
    const message = m.av_annotation_hidden({ shortcut: apple ? "⌘ + ." : "Ctrl + ." });
    taps.current = [];
    if (hidden) toast.dismissShown(message);
    else {
      onExitAnnotate();
      setCardOpen(false);
      toast.notice(message);
    }
    setHidden(!hidden);
    localStorage.setItem("artifact-annotation-hidden", String(!hidden));
  }, [apple, hidden, toast, onExitAnnotate]);

  useEffect(() => {
    const release = () => {
      restoreKey.current = null;
    };
    const keyUp = (event: KeyboardEvent) => {
      if ((event.code || event.key) === restoreKey.current) release();
    };
    const restore = (event: KeyboardEvent) => {
      const key = event.code || event.key;
      const repeatingRestore = event.repeat && restoreKey.current === key;
      if (
        !repeatingRestore &&
        (!hidden ||
          event.defaultPrevented ||
          isRecordingShortcut() ||
          isEditableTarget(event.target) ||
          !hotkeyMatchesEvent("Mod+.", event, apple))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        restoreKey.current = key;
        toggleVisibility();
      }
    };
    window.addEventListener("keydown", restore, true);
    window.addEventListener("keyup", keyUp, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", restore, true);
      window.removeEventListener("keyup", keyUp, true);
      window.removeEventListener("blur", release);
    };
  }, [hidden, apple, toggleVisibility]);

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isRecordingShortcut() || isEditableTarget(event.target)) return;

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      if (showCard && !isCompose && count > 0 && !locked) {
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
        setFocusedIdx(-1);
        setCardOpen(false);
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
        void actions.remove(target);
        setFocusedIdx((index) => Math.min(index, count - 2));
      }
    }
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const onOrbPress = () => {
    if (!showCard) {
      setCardOpen(true);
      if (count === 0 && !annotating) onToggleAnnotate();
      return;
    }
    if (isCompose) {
      exitComposeToList();
      return;
    }
    setCardOpen(false);
  };

  const editorHasContent = hasContent(segments);
  const canHide = !editingDraft && !pickedAnchor && !editorHasContent && !saving;
  const canSave = editingDraft
    ? (editorHasContent || editingDraft.images.length > 0) && !saving && !locked
    : editorHasContent && !saving && !locked && !drafts.atLimit;

  if (hidden)
    return (
      <AriaButton
        aria-label={m.av_show_annotation_button()}
        className="absolute right-4 bottom-4 z-20 size-10 touch-manipulation rounded-full bg-transparent outline-focus-ring focus-visible:outline-2"
        onPress={(event) => {
          const now = performance.now();
          taps.current = [...taps.current.filter((time) => now - time < 850), now];
          if (
            event.pointerType === "keyboard" ||
            event.pointerType === "virtual" ||
            taps.current.length === 3
          )
            toggleVisibility();
        }}
      />
    );
  return (
    <div
      data-artifact-review-pill=""
      className="pointer-events-none absolute right-4 bottom-4 z-20 flex max-w-[calc(100%-2rem)] flex-col items-end gap-2"
    >
      {showCard && (
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
                    strokeWidth={1.25}
                    className="size-3 shrink-0 fill-current"
                  />
                  <span>{m.av_cm_pick_hint()}</span>
                </div>
                {nonElementPicked ? (
                  <div className="mb-2 flex items-center">
                    <AnchorChip
                      label={formatAnchorTag(nonElementPicked.anchor, nonElementPicked.path)}
                      onRemove={nonElementPicked.onClear}
                    />
                  </div>
                ) : (
                  editingDraft?.anchor &&
                  editingDraft.anchor.type !== "element" && (
                    <div className="mb-2 flex items-center">
                      <AnchorChip label={formatAnchorTag(editingDraft.anchor, editingDraft.path)} />
                    </div>
                  )
                )}
                <ArtifactInlineEditor
                  ref={editorRef}
                  label={m.av_cm_field_label()}
                  placeholder={m.av_dr_compose_placeholder()}
                  disabled={saving || locked}
                  onSegmentsChange={handleSegmentsChange}
                  onSubmit={() => void saveForm(false)}
                  onSubmitAndSend={() => void saveForm(true)}
                  onCancel={exitComposeToList}
                />
                {saveError && (
                  <p role="alert" className="mt-1.5 text-xs text-error-primary">
                    {saveError}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-secondary/70 px-3.5 py-2.5">
                <CoForgeMark className="h-3.5 shrink-0 opacity-60 transition-opacity duration-150 hover:opacity-90" />
                <div className="flex items-center gap-2">
                  <Tooltip title={<TooltipWithKey label={m.controls_cancel()} shortcut="Esc" />}>
                    <AriaButton
                      isDisabled={saving}
                      onPress={exitComposeToList}
                      className={SECONDARY_PILL_CLASS}
                    >
                      <span>{m.controls_cancel()}</span>
                    </AriaButton>
                  </Tooltip>
                  <Tooltip
                    title={
                      <TooltipShortcutRows
                        rows={[
                          {
                            label: editingDraft ? m.av_dr_save() : m.av_dr_add_tip(),
                            shortcut: "Enter",
                          },
                          {
                            label: m.av_dr_add_and_send_tip(),
                            shortcut: modEnter,
                          },
                        ]}
                      />
                    }
                  >
                    <AriaButton
                      isDisabled={!canSave}
                      data-save-draft=""
                      onPress={() => void saveForm(false)}
                      className={PRIMARY_PILL_CLASS}
                    >
                      {!editingDraft && <Plus aria-hidden="true" className="size-3.5" />}
                      <span>{editingDraft ? m.av_dr_save() : m.av_dr_add()}</span>
                    </AriaButton>
                  </Tooltip>
                </div>
              </div>
            </>
          ) : (
            <ArtifactReviewQueue
              drafts={drafts.drafts}
              focusedIdx={focusedIdx}
              locked={locked}
              atLimit={drafts.atLimit}
              modEnter={modEnter}
              onOpenDraft={actions.openDraft}
              onEditDraft={startEdit}
              onRemoveDraft={(draft) => void actions.remove(draft)}
              onNewComment={enterCompose}
              onSubmit={() => void actions.submit()}
            />
          )}
        </div>
      )}

      <div className="group/fab pointer-events-auto relative flex items-center">
        {canHide && (
          <AriaButton
            onPress={toggleVisibility}
            className={cn(
              showCard && "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
              "pointer-events-none absolute right-full whitespace-nowrap rounded-lg bg-primary px-2 py-1 text-xs text-secondary opacity-0 shadow-sm ring-1 ring-secondary transition-opacity group-hover/fab:pointer-events-auto group-hover/fab:opacity-100 group-focus-within/fab:pointer-events-auto group-focus-within/fab:opacity-100",
            )}
          >
            {m.av_hide_annotation_button()}
          </AriaButton>
        )}
        <ArtifactReviewFab annotating={annotating} count={count} onPress={onOrbPress} />
      </div>
    </div>
  );
}
