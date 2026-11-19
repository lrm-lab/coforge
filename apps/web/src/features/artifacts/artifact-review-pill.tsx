import { useEffect, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import {
  ArrowRight,
  CursorClick01,
  Edit03,
  FlipBackward,
  FlipForward,
  Plus,
  Trash01,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { FLOATING_SURFACE_CLASS } from "#src/features/conversations/review-chrome";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import type { CommentDraftView } from "./artifact-comment-drafts-queries";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return target.closest('[role="dialog"], [aria-modal="true"]') !== null;
}

function draftAnchorBadge(draft: CommentDraftView): string {
  const anchor = draft.anchor;
  if (anchor?.type === "element") {
    const label = typeof anchor.data.label === "string" ? anchor.data.label.trim() : "";
    const selector = typeof anchor.data.selector === "string" ? anchor.data.selector : "";
    return label || selector || draft.path || "page";
  }
  if (anchor?.type === "text") {
    const quote = typeof anchor.data.quote === "string" ? anchor.data.quote.trim() : "";
    if (!quote) return draft.path || "page";
    return quote.length > 28 ? `“${quote.slice(0, 28)}…”` : `“${quote}”`;
  }
  if (anchor?.type === "lines") {
    return anchor.data.from === anchor.data.to
      ? `L${anchor.data.from}`
      : `L${anchor.data.from}–${anchor.data.to}`;
  }
  return draft.path || "page";
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
  const drafts = useCommentDrafts();
  const actions = useCommentDraftActions();
  const [discarding, setDiscarding] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const prevCount = useRef(drafts.drafts.length);

  const count = drafts.drafts.length;
  const locked = drafts.busy;
  const hasHistory = drafts.canUndo || drafts.canRedo;
  const editingDraft = editingId
    ? (drafts.drafts.find((item) => item.id === editingId) ?? null)
    : null;

  useEffect(() => {
    if (count > prevCount.current) {
      setCardOpen(true);
      if (annotating) onExitAnnotate();
    }
    prevCount.current = count;
  }, [count, annotating, onExitAnnotate]);

  useEffect(() => {
    if (annotating) setCardOpen(true);
  }, [annotating]);

  useEffect(() => {
    if (editingDraft) editInputRef.current?.focus();
  }, [editingDraft]);

  const showCard = cardOpen && (annotating || editingDraft !== null || count > 0 || hasHistory);

  const startEdit = (draft: CommentDraftView) => {
    if (locked) return;
    if (annotating) onExitAnnotate();
    setEditingId(draft.id);
    setEditBody(draft.body);
    setCardOpen(true);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditBody("");
  };

  const saveEdit = async () => {
    if (!editingDraft || savingEdit || locked) return;
    const trimmed = editBody.trim();
    if (!trimmed && editingDraft.images.length === 0) return;
    setSavingEdit(true);
    try {
      await actions.edit(editingDraft, trimmed);
      setEditingId(null);
      setEditBody("");
    } finally {
      setSavingEdit(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        if (showCard && !annotating && !editingDraft && count > 0 && !locked) {
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
        (showCard && !annotating && !editingDraft && (event.key === "n" || event.key === "N"))
      ) {
        event.preventDefault();
        setEditingId(null);
        setFocusedIdx(-1);
        setCardOpen(true);
        if (!annotating) onToggleAnnotate();
        return;
      }

      if (event.key === "Escape") {
        if (editingDraft) {
          event.preventDefault();
          cancelEdit();
        } else if (annotating) {
          event.preventDefault();
          onExitAnnotate();
          if (count === 0 && !hasHistory) setCardOpen(false);
        } else if (cardOpen) {
          event.preventDefault();
          setCardOpen(false);
          setFocusedIdx(-1);
        }
        return;
      }

      if (showCard && !annotating && !editingDraft && count > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setFocusedIdx((index) => (index + 1) % count);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setFocusedIdx((index) => (index <= 0 ? count - 1 : index - 1));
        } else if ((event.key === "e" || event.key === "E") && focusedIdx >= 0) {
          const target = drafts.drafts[focusedIdx];
          if (target) {
            event.preventDefault();
            startEdit(target);
          }
        } else if ((event.key === "Backspace" || event.key === "Delete") && focusedIdx >= 0) {
          const target = drafts.drafts[focusedIdx];
          if (target && !locked) {
            event.preventDefault();
            void actions.remove(target);
            setFocusedIdx((index) => Math.min(index, count - 2));
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    actions,
    annotating,
    cardOpen,
    count,
    drafts.drafts,
    editingDraft,
    focusedIdx,
    hasHistory,
    locked,
    onExitAnnotate,
    onToggleAnnotate,
    onTogglePanel,
    showCard,
  ]);

  const onOrbPress = () => {
    if (!showCard) {
      setCardOpen(true);
      if (count === 0 && !annotating) onToggleAnnotate();
      return;
    }
    if (annotating && count > 0) {
      onExitAnnotate();
      return;
    }
    if (annotating) onExitAnnotate();
    setEditingId(null);
    setCardOpen(false);
  };

  return (
    <>
      <div
        role="group"
        aria-label={m.av_dr_tools()}
        data-comment-tools=""
        className="pointer-events-none absolute right-4 bottom-4 z-20 flex max-w-[calc(100%-2rem)] flex-col items-end gap-2.5"
      >
        {showCard && (
          <div
            className={cn(
              "pointer-events-auto w-[25rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-secondary bg-primary shadow-xl",
              "animate-in fade-in slide-in-from-bottom-1 motion-enter-sm",
            )}
          >
            {editingDraft ? (
              <>
                <div className="p-3.5 pb-2">
                  <div className="mb-2 flex items-center gap-1.5">
                    <span className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-warning-secondary px-1.5 py-0.5 font-mono text-xs font-medium text-warning-primary">
                      {draftAnchorBadge(editingDraft)}
                    </span>
                  </div>
                  <textarea
                    ref={editInputRef}
                    rows={3}
                    value={editBody}
                    disabled={savingEdit || locked}
                    onChange={(event) => setEditBody(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void saveEdit();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelEdit();
                      }
                    }}
                    className="block w-full resize-none border-0 bg-transparent text-sm text-primary outline-hidden placeholder:text-placeholder"
                  />
                </div>
                <div className="flex items-center justify-between border-t border-secondary px-3 py-2">
                  <CoForgeMark className="h-3.5 opacity-80" />
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="xs"
                      color="secondary"
                      isDisabled={savingEdit}
                      onPress={cancelEdit}
                    >
                      {m.controls_cancel()}
                    </Button>
                    <Button
                      size="xs"
                      color="primary"
                      isLoading={savingEdit}
                      isDisabled={locked || (!editBody.trim() && editingDraft.images.length === 0)}
                      onPress={() => void saveEdit()}
                    >
                      {m.av_dr_add()}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {annotating && (
                  <div className="flex items-center gap-2 border-b border-secondary bg-secondary/50 px-3.5 py-2.5 text-xs text-tertiary">
                    <CursorClick01
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-warning-primary"
                    />
                    <span>{m.av_cm_pick_hint()}</span>
                  </div>
                )}
                {count > 0 && (
                  <ul className="max-h-56 divide-y divide-secondary overflow-y-auto">
                    {drafts.drafts.map((draft, index) => (
                      <li
                        key={draft.id}
                        className={cn(
                          "flex items-start gap-2.5 px-3.5 py-2.5 transition-colors duration-150",
                          focusedIdx === index && "bg-secondary/60",
                        )}
                      >
                        <AriaButton
                          onPress={() => actions.openDraft(draft)}
                          className="min-w-0 flex-1 cursor-pointer text-left text-sm leading-relaxed text-primary outline-focus-ring focus-visible:outline-2"
                        >
                          <span className="mr-1.5 inline-flex max-w-44 align-middle truncate rounded-md bg-warning-secondary px-1.5 py-0.5 font-mono text-xs font-medium text-warning-primary">
                            {draftAnchorBadge(draft)}
                          </span>
                          <span className="break-words">{draft.body}</span>
                        </AriaButton>
                        <div className="flex shrink-0 items-center gap-0.5">
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
                )}
                <div className="flex items-center justify-between gap-2 border-t border-secondary px-3 py-2">
                  <div className="flex items-center gap-1">
                    <CoForgeMark className="mr-1 h-3.5 opacity-80" />
                    {hasHistory && (
                      <>
                        <ButtonUtility
                          icon={FlipBackward}
                          size="xs"
                          color="tertiary"
                          tooltip={m.av_dr_undo()}
                          isDisabled={!drafts.canUndo || locked}
                          data-draft-undo=""
                          onClick={actions.undo}
                        />
                        <ButtonUtility
                          icon={FlipForward}
                          size="xs"
                          color="tertiary"
                          tooltip={m.av_dr_redo()}
                          isDisabled={!drafts.canRedo || locked}
                          data-draft-redo=""
                          onClick={actions.redo}
                        />
                      </>
                    )}
                    {count > 0 && (
                      <Button
                        size="xs"
                        color="tertiary"
                        isDisabled={locked}
                        data-draft-discard=""
                        onPress={() => setDiscarding(true)}
                      >
                        {m.av_dr_discard()}
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {annotating ? (
                      <Button size="xs" color="secondary" onPress={onExitAnnotate}>
                        {m.controls_cancel()}
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        color="secondary"
                        iconLeading={Plus}
                        onPress={() => {
                          if (!annotating) onToggleAnnotate();
                        }}
                      >
                        {m.av_dr_new_comment()}
                      </Button>
                    )}
                    {count > 0 && (
                      <Button
                        size="xs"
                        color="primary"
                        iconTrailing={ArrowRight}
                        isDisabled={locked}
                        isLoading={drafts.submitting}
                        data-draft-send=""
                        aria-label={m.av_dr_send_all_tip()}
                        onPress={() => void actions.submit()}
                      >
                        {m.av_dr_send_all()}
                      </Button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <div
          className={cn(
            "pointer-events-auto relative flex items-center rounded-full p-1",
            FLOATING_SURFACE_CLASS,
            annotating && "ring-2 ring-warning-primary/50",
          )}
        >
          <ButtonUtility
            icon={CursorClick01}
            size="sm"
            color="tertiary"
            tooltip={annotating ? m.av_cm_annotating() : m.av_cm_annotate()}
            aria-pressed={annotating}
            data-annotate-toggle=""
            className={cn(
              "rounded-full",
              annotating && "bg-warning-secondary text-warning-primary hover:bg-warning-secondary",
            )}
            onClick={onOrbPress}
          />
          {count > 0 && !annotating && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-1 -right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-warning-solid px-1 text-[11px] font-semibold text-white tabular-nums shadow-xs"
            >
              {count}
            </span>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title={m.av_dr_discard_title({ count })}
        description={m.av_dr_discard_body()}
        confirmLabel={m.av_dr_discard_confirm()}
        errorMessage={m.av_dr_discard_failed()}
        onConfirm={async () => {
          await actions.discardAll();
          setDiscarding(false);
        }}
      />
    </>
  );
}
