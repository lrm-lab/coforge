import { useEffect, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ArrowRight, CursorClick01, Edit03, Plus, Trash01 } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";
import { useArtifactCommenting } from "./artifact-commenting";
import { AnchorChip, formatAnchorTag } from "./artifact-review-chrome";
import { draftFailure } from "./use-comment-drafts";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return target.closest('[role="dialog"], [aria-modal="true"]') !== null;
}

export function ArtifactReviewPill({
  annotating,
  onToggleAnnotate,
  onExitAnnotate,
  onTogglePanel,
}: {
  annotating: boolean;
  onToggleAnnotate: () => void;
  onExitAnnotate: () => void;
  onTogglePanel: () => void;
}) {
  const { version, pickedAnchor } = useArtifactCommenting();
  const drafts = useCommentDrafts();
  const actions = useCommentDraftActions();
  const [cardOpen, setCardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevCount = useRef(drafts.drafts.length);

  const count = drafts.drafts.length;
  const locked = drafts.busy;
  const editingDraft = editingId
    ? (drafts.drafts.find((item) => item.id === editingId) ?? null)
    : null;
  const isCompose = editingDraft !== null || annotating || pickedAnchor !== null;
  const showCard = cardOpen && (isCompose || count > 0);

  useEffect(() => {
    if (count > prevCount.current) setCardOpen(true);
    prevCount.current = count;
  }, [count]);

  useEffect(() => {
    if (annotating || pickedAnchor) setCardOpen(true);
  }, [annotating, pickedAnchor]);

  useEffect(() => {
    if (showCard && isCompose) textareaRef.current?.focus();
  }, [showCard, isCompose, pickedAnchor, editingId]);

  const enterCompose = () => {
    setEditingId(null);
    setDraftBody("");
    setSaveError(null);
    setFocusedIdx(-1);
    setCardOpen(true);
    if (!annotating) onToggleAnnotate();
  };

  const exitComposeToList = () => {
    setEditingId(null);
    setDraftBody("");
    setSaveError(null);
    pickedAnchor?.onClear();
    if (annotating) onExitAnnotate();
    if (count === 0) setCardOpen(false);
  };

  const startEdit = (draft: CommentDraftView) => {
    if (locked) return;
    pickedAnchor?.onClear();
    if (annotating) onExitAnnotate();
    setEditingId(draft.id);
    setDraftBody(draft.body);
    setSaveError(null);
    setCardOpen(true);
  };

  const saveForm = async () => {
    if (saving || locked) return;
    const trimmed = draftBody.trim();
    if (editingDraft) {
      if (!trimmed && editingDraft.images.length === 0) return;
      setSaving(true);
      setSaveError(null);
      try {
        await actions.edit(editingDraft, trimmed);
        setEditingId(null);
        setDraftBody("");
      } catch (error) {
        setSaveError(draftFailure(error));
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!trimmed) return;
    setSaving(true);
    setSaveError(null);
    try {
      await actions.create({
        version: pickedAnchor?.version ?? version,
        body: trimmed,
        ...(pickedAnchor ? { path: pickedAnchor.path, anchor: pickedAnchor.anchor } : {}),
      });
      setDraftBody("");
      pickedAnchor?.onClear();
      if (annotating) onExitAnnotate();
      setCardOpen(true);
    } catch (error) {
      setSaveError(draftFailure(error));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;

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

      if (
        event.key === "c" ||
        event.key === "C" ||
        (showCard && !isCompose && (event.key === "n" || event.key === "N"))
      ) {
        event.preventDefault();
        setEditingId(null);
        setDraftBody("");
        setSaveError(null);
        setFocusedIdx(-1);
        setCardOpen(true);
        if (!annotating) onToggleAnnotate();
        return;
      }

      if (event.key === "Escape") {
        if (isCompose) {
          event.preventDefault();
          setEditingId(null);
          setDraftBody("");
          setSaveError(null);
          pickedAnchor?.onClear();
          if (annotating) onExitAnnotate();
          if (count === 0) setCardOpen(false);
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
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedIdx((index) => (index <= 0 ? count - 1 : index - 1));
        return;
      }
      if ((event.key === "e" || event.key === "E") && focusedIdx >= 0 && focusedIdx < count) {
        event.preventDefault();
        const target = drafts.drafts[focusedIdx];
        if (target) startEdit(target);
        return;
      }
      if (
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

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const onOrbPress = () => {
    if (!showCard) {
      setCardOpen(true);
      if (count === 0 && !annotating) onToggleAnnotate();
      return;
    }
    if (isCompose && count > 0) {
      exitComposeToList();
      return;
    }
    setEditingId(null);
    setDraftBody("");
    setSaveError(null);
    pickedAnchor?.onClear();
    if (annotating) onExitAnnotate();
    setCardOpen(false);
  };

  const canSave = editingDraft
    ? (draftBody.trim() !== "" || editingDraft.images.length > 0) && !saving && !locked
    : draftBody.trim() !== "" && !saving && !locked && !drafts.atLimit;

  return (
    <div
      data-artifact-review-pill=""
      className="pointer-events-none absolute right-4 bottom-4 z-20 flex flex-col items-end gap-2.5"
    >
      {showCard && (
        <div
          data-review-card=""
          className={cn(
            "pointer-events-auto w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-secondary bg-primary shadow-xl",
            "animate-in fade-in slide-in-from-bottom-1 motion-enter-sm",
          )}
        >
          {isCompose ? (
            <>
              <div className="px-3.5 pt-3 pb-2.5">
                <div className="mb-2 flex min-h-6 items-center gap-1.5">
                  {editingDraft ? (
                    <AnchorChip label={formatAnchorTag(editingDraft.anchor, editingDraft.path)} />
                  ) : pickedAnchor ? (
                    <AnchorChip
                      label={formatAnchorTag(pickedAnchor.anchor, pickedAnchor.path)}
                      onRemove={pickedAnchor.onClear}
                    />
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-tertiary">
                      <CursorClick01
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-warning-solid"
                      />
                      <span>{m.av_cm_pick_hint()}</span>
                    </span>
                  )}
                </div>
                <textarea
                  ref={textareaRef}
                  rows={3}
                  value={draftBody}
                  disabled={saving || locked}
                  placeholder={m.av_dr_compose_placeholder()}
                  onChange={(event) => setDraftBody(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      void saveForm();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      exitComposeToList();
                      return;
                    }
                    if (
                      event.key === "Backspace" &&
                      draftBody === "" &&
                      !editingDraft &&
                      pickedAnchor
                    ) {
                      event.preventDefault();
                      pickedAnchor.onClear();
                      return;
                    }
                    if (
                      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
                      draftBody === "" &&
                      !editingDraft &&
                      pickedAnchor?.trail
                    ) {
                      const step = event.key === "ArrowUp" ? -1 : 1;
                      const next = pickedAnchor.trail.at + step;
                      if (next >= 0 && next < pickedAnchor.trail.names.length) {
                        event.preventDefault();
                        pickedAnchor.onRetarget?.(pickedAnchor.trail.step(next));
                      }
                    }
                  }}
                  className="block w-full resize-none border-0 bg-transparent text-sm leading-relaxed text-primary outline-hidden placeholder:text-placeholder"
                />
                {saveError && <p className="mt-1.5 text-xs text-error-primary">{saveError}</p>}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-secondary px-3.5 py-2.5">
                <CoForgeMark className="h-3.5 shrink-0 opacity-70" />
                <div className="flex items-center gap-2">
                  <AriaButton
                    isDisabled={saving}
                    onPress={exitComposeToList}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-secondary bg-secondary px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-secondary_hover disabled:opacity-50"
                  >
                    {!editingDraft && count > 0
                      ? m.av_dr_back_to_list({ count })
                      : m.controls_cancel()}
                  </AriaButton>
                  <AriaButton
                    isDisabled={!canSave}
                    data-save-draft=""
                    onPress={() => void saveForm()}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-primary-solid px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-950"
                  >
                    {!editingDraft && <Plus aria-hidden="true" className="size-3.5" />}
                    <span>{editingDraft ? m.av_dr_save() : m.av_dr_add()}</span>
                  </AriaButton>
                </div>
              </div>
            </>
          ) : (
            <>
              <ul className="max-h-60 divide-y divide-secondary overflow-y-auto">
                {drafts.drafts.map((draft, index) => (
                  <li
                    key={draft.id}
                    className={cn(
                      "flex items-start gap-2.5 px-3.5 py-3 transition-colors duration-150",
                      focusedIdx === index && "bg-secondary/60",
                    )}
                  >
                    <AriaButton
                      onPress={() => actions.openDraft(draft)}
                      className="min-w-0 flex-1 cursor-pointer text-left text-sm leading-relaxed text-primary outline-focus-ring focus-visible:outline-2"
                    >
                      <AnchorChip
                        label={formatAnchorTag(draft.anchor, draft.path)}
                        className="mr-1.5 align-baseline"
                      />
                      <span className="break-words">{draft.body}</span>
                    </AriaButton>
                    <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                      <ButtonUtility
                        icon={Edit03}
                        size="xs"
                        color="tertiary"
                        tooltip={m.av_cm_edit()}
                        isDisabled={locked}
                        onClick={() => startEdit(draft)}
                      />
                      <ButtonUtility
                        icon={Trash01}
                        size="xs"
                        color="tertiary"
                        tooltip={m.av_cm_delete()}
                        isDisabled={locked}
                        onClick={() => void actions.remove(draft)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-2 border-t border-secondary px-3.5 py-2.5">
                <CoForgeMark className="h-3.5 shrink-0 opacity-70" />
                <div className="flex items-center gap-2">
                  <AriaButton
                    isDisabled={locked || drafts.atLimit}
                    onPress={enterCompose}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-secondary bg-secondary px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-secondary_hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus aria-hidden="true" className="size-3.5" />
                    <span>{m.av_dr_new_comment()}</span>
                  </AriaButton>
                  <Tooltip title={m.av_dr_send_all_tip()}>
                    <AriaButton
                      isDisabled={locked}
                      data-draft-send=""
                      aria-label={m.av_dr_send_all_tip()}
                      onPress={() => void actions.submit()}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-primary-solid px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-950"
                    >
                      <span>{m.av_dr_send_all()}</span>
                      <ArrowRight aria-hidden="true" className="size-3.5" />
                    </AriaButton>
                  </Tooltip>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <Tooltip title={annotating ? m.av_cm_annotating() : m.av_cm_annotate()}>
        <AriaButton
          aria-pressed={annotating}
          aria-label={annotating ? m.av_cm_annotating() : m.av_cm_annotate()}
          data-annotate-toggle=""
          onPress={onOrbPress}
          className={cn(
            "pointer-events-auto relative flex size-11 cursor-pointer items-center justify-center rounded-full border border-secondary bg-primary text-primary shadow-lg transition-transform duration-150 hover:scale-[1.03] active:scale-[0.97] dark:border-transparent dark:bg-white dark:text-gray-950",
            annotating &&
              "ring-2 ring-warning-solid ring-offset-2 ring-offset-primary text-warning-primary dark:text-warning-solid",
          )}
        >
          <CursorClick01 aria-hidden="true" className="size-5" />
          {count > 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-warning-solid text-xs leading-none font-semibold text-white tabular-nums shadow-xs"
            >
              {count}
            </span>
          )}
        </AriaButton>
      </Tooltip>
    </div>
  );
}
